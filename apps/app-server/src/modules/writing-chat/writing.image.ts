import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ImagePorts } from "@zhishu/ai-plugins/image";
import type { ImageJob } from "@zhishu/ai-plugins/contracts";
import type { AppConfig } from "../../config.js";
import { AssetObjectStorage } from "../assets/asset-storage.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";

interface BufferedPng {
  base64: string;
  width: number;
  height: number;
}
export class WritingImages {
  constructor(
    private pool: Pool,
    private config: AppConfig,
    private storage: AssetObjectStorage | null,
  ) {}
  capability() {
    return {
      available: !!(this.config.AI_IMAGE_MODEL && this.config.AI_IMAGE_API_KEY && this.storage),
      reason:
        this.config.AI_IMAGE_MODEL && this.config.AI_IMAGE_API_KEY && this.storage
          ? "每次一张 1024×1024 PNG；停止不会撤销已产生的外部费用"
          : "图片服务或私有存储尚未配置",
    };
  }
  ports(principal: Principal, conversationId: string): ImagePorts {
    const idFor = (key: string) =>
      `image_${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
    return {
      load: async (key) => {
        const result = await this.pool.query<{ job: ImageJob }>(
          "select job from writing_image_jobs where key=$1 and conversation_id=$2",
          [key, conversationId],
        );
        return result.rows[0]?.job;
      },
      save: async (key, job) => {
        await this.pool.query(
          "insert into writing_image_jobs(key,conversation_id,job) values($1,$2,$3) on conflict(key) do update set job=excluded.job,provider_result=case when excluded.job->>'status'='ready' then null else writing_image_jobs.provider_result end,updated_at=now() where writing_image_jobs.conversation_id=excluded.conversation_id",
          [key, conversationId, JSON.stringify(job)],
        );
      },
      reserve: async (_key, signal) => {
        signal.throwIfAborted();
        const count = await this.pool.query<{ count: string }>(
          "select count(*) from writing_image_jobs where conversation_id=$1",
          [conversationId],
        );
        if (Number(count.rows[0]?.count) >= 2)
          throw new DomainError("RESOURCE_LIMIT", "本次对话的图片额度已用完");
        const unsettled = await this.pool.query(
          "select 1 from writing_image_jobs where conversation_id=$1 and job->>'status' in ('unknown','pending') limit 1",
          [conversationId],
        );
        if (unsettled.rowCount)
          throw new DomainError("CONFLICT", "原图片任务结果尚未确认，请先查询或重试保存");
      },
      provider: this.capability().available
        ? {
            create: async (input, signal) => {
              const jobId = idFor(input.idempotencyKey);
              const response = await fetch(
                `${(this.config.AI_IMAGE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/images/generations`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    Authorization: `Bearer ${this.config.AI_IMAGE_API_KEY}`,
                  },
                  body: JSON.stringify({
                    model: this.config.AI_IMAGE_MODEL,
                    prompt: input.prompt,
                    n: 1,
                    size: "1024x1024",
                    output_format: "png",
                  }),
                  signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.AI_TIMEOUT_MS)]),
                },
              );
              if (!response.ok || !response.body)
                throw new DomainError("SERVICE_UNAVAILABLE", "图片生成未能确认，请查询原任务状态");
              let bytes = 0;
              const chunks: Uint8Array[] = [];
              for await (const chunk of response.body) {
                bytes += chunk.byteLength;
                if (bytes > 28000000) throw new Error("IMAGE_RESPONSE_LIMIT");
                chunks.push(chunk);
              }
              const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const value = data as { data?: { b64_json?: unknown }[] };
              const base64 = value.data?.length === 1 ? value.data[0]?.b64_json : undefined;
              if (typeof base64 !== "string" || base64.length > 27000000)
                throw new Error("INVALID_IMAGE_RESPONSE");
              const png = Buffer.from(base64, "base64");
              if (
                png.toString("base64") !== base64 ||
                png.length < 24 ||
                !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              )
                throw new Error("INVALID_IMAGE_BYTES");
              const width = png.readUInt32BE(16),
                height = png.readUInt32BE(20);
              if (width !== 1024 || height !== 1024) throw new Error("INVALID_IMAGE_DIMENSIONS");
              const buffered: BufferedPng = { base64, width, height };
              await this.pool.query(
                "update writing_image_jobs set provider_result=$3,job=$4,updated_at=now() where key=$1 and conversation_id=$2",
                [
                  input.idempotencyKey,
                  conversationId,
                  JSON.stringify(buffered),
                  JSON.stringify({ id: jobId, status: "pending" }),
                ],
              );
              return { jobId };
            },
            poll: async (jobId) => {
              const result = await this.pool.query<{
                provider_result: BufferedPng | null;
                job: ImageJob;
              }>(
                "select provider_result,job from writing_image_jobs where conversation_id=$1 and job->>'id'=$2",
                [conversationId, jobId],
              );
              const buffered = result.rows[0]?.provider_result;
              if (!buffered) throw new DomainError("CONFLICT", "图片外部结果未确认，不能重复生成");
              return {
                status: "ready",
                images: [
                  {
                    bytes: Buffer.from(buffered.base64, "base64"),
                    mime: "image/png",
                    width: buffered.width,
                    height: buffered.height,
                  },
                ],
              };
            },
          }
        : undefined,
      store: async (key, image, signal) => {
        signal.throwIfAborted();
        if (!this.storage) throw new DomainError("SERVICE_UNAVAILABLE", "私有存储不可用");
        const assetId = idFor(key.replace(/:0$/, ""));
        await this.storage.put({
          objectKey: this.objectKey(principal, conversationId, assetId),
          bytes: Buffer.from(image.bytes),
          mediaType: image.mime,
          sha256: createHash("sha256").update(image.bytes).digest("hex"),
        });
        return { assetId, mime: image.mime, width: image.width, height: image.height };
      },
    };
  }
  private objectKey(principal: Principal, id: string, assetId: string) {
    return `tenants/${principal.tenantId}/writing/${id}/${assetId}.png`;
  }
  async list(conversationId: string) {
    const rows = await this.pool.query<{ job: ImageJob }>(
      "select job from writing_image_jobs where conversation_id=$1 order by updated_at limit 20",
      [conversationId],
    );
    return rows.rows.map((r) => r.job);
  }
  async refresh(principal: Principal, id: string, jobId: string) {
    const result = await this.pool.query<{
      key: string;
      job: ImageJob;
      provider_result: BufferedPng | null;
    }>(
      "select key,job,provider_result from writing_image_jobs where conversation_id=$1 and job->>'id'=$2",
      [id, jobId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "图片任务不可访问");
    if (row.job.status !== "pending" || !row.provider_result) return row.job;
    const ports = this.ports(principal, id),
      buffered = row.provider_result;
    const asset = await ports.store(
      `${row.key}:0`,
      {
        bytes: Buffer.from(buffered.base64, "base64"),
        mime: "image/png",
        width: buffered.width,
        height: buffered.height,
      },
      new AbortController().signal,
    );
    const job: ImageJob = { id: jobId, status: "ready", assets: [asset] };
    await ports.save(row.key, job);
    return job;
  }
  async access(principal: Principal, id: string, assetId: string) {
    const jobs = await this.list(id);
    const asset = jobs
      .flatMap((j) => (j.status === "ready" ? j.assets : []))
      .find((a) => a.assetId === assetId);
    if (!asset || !this.storage) throw new DomainError("NOT_FOUND", "图片不可访问");
    return {
      url: await this.storage.createReadUrl({
        objectKey: this.objectKey(principal, id, assetId),
        fileName: "生成图片.png",
        mediaType: asset.mime,
        expiresIn: this.config.ASSET_ACCESS_URL_TTL_SECONDS,
      }),
      expiresAt: new Date(
        Date.now() + this.config.ASSET_ACCESS_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }
}
