import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ImageJob, ImagePorts } from "@zhishu/ai-writing";
import type { AppConfig } from "../../config.js";
import { AssetObjectStorage } from "../assets/asset-storage.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";

interface BufferedPng {
  base64: string;
  width: number;
  height: number;
}
interface ReadyMeta {
  width: number;
  height: number;
  mime: "image/png";
}

/** Image jobs are external side effects: pending/unknown outcomes are never blindly replayed. */
export class WritingImages {
  constructor(
    private pool: Pool,
    private config: AppConfig,
    private storage: AssetObjectStorage | null,
  ) {}
  capability() {
    const configured = !!(
      this.config.AI_IMAGE_MODEL &&
      this.config.AI_IMAGE_API_KEY &&
      this.storage
    );
    return {
      available: configured,
      reason: configured
        ? "每次一张 1024×1024 PNG；停止不会撤销已产生的外部费用"
        : "图片服务或私有存储尚未配置",
    };
  }
  private idFor = (key: string) =>
    `image_${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;

  ports(ctx: { principal: Principal; conversationId: string; runId: string }): {
    ports: ImagePorts;
    jobEvents: () => ImageJob[];
  } {
    const observed: ImageJob[] = [];
    const { principal, conversationId, runId } = ctx;
    const rowFor = async (key: string) => {
      const result = await this.pool.query<{
        status: ImageJob["status"];
        asset_id: string | null;
        provider_result: (ReadyMeta & Partial<BufferedPng>) | null;
      }>(
        "select status,asset_id,provider_result from writing_image_jobs where id=$1 and conversation_id=$2",
        [key, conversationId],
      );
      return result.rows[0];
    };
    const jobFrom = (
      key: string,
      row: NonNullable<Awaited<ReturnType<typeof rowFor>>>,
    ): ImageJob | undefined => {
      if (row.status === "ready" && row.asset_id && row.provider_result)
        return {
          id: this.idFor(key.replace(/:\d+$/, "")),
          status: "ready",
          assets: [
            {
              assetId: row.asset_id,
              mime: row.provider_result.mime,
              width: row.provider_result.width,
              height: row.provider_result.height,
            },
          ],
        };
      if (row.status === "ready") return;
      return {
        id: row.asset_id ?? this.idFor(key),
        status: row.status,
        ...(row.status === "failed" ? { code: "IMAGE_FAILED" } : {}),
      };
    };
    const ports: ImagePorts = {
      load: async (key) => {
        const row = await rowFor(key);
        return row ? jobFrom(key, row) : undefined;
      },
      save: async (key, job) => {
        observed.push(job);
        const toolCallId = key.slice(key.indexOf(":") + 1);
        await this.pool.query(
          `insert into writing_image_jobs(id,tenant_id,conversation_id,run_id,purpose,tool_call_id,status,asset_id,provider_result)
           values($1,$2,$3,$4,'writing',$5,$6,$7,$8)
           on conflict(id) do update set status=excluded.status,
             asset_id=excluded.asset_id,
             provider_result=coalesce(excluded.provider_result, writing_image_jobs.provider_result),
             updated_at=now()`,
          [
            key,
            principal.tenantId,
            conversationId,
            runId,
            toolCallId.slice(0, 160),
            job.status,
            job.status === "ready" ? job.assets[0].assetId : null,
            // The provider pipeline validates single PNG 1024x1024 before store; meta stays png.
            job.status === "ready"
              ? JSON.stringify({
                  width: job.assets[0].width,
                  height: job.assets[0].height,
                  mime: "image/png",
                } satisfies ReadyMeta)
              : null,
          ],
        );
      },
      reserve: async (key, signal) => {
        signal.throwIfAborted();
        const count = await this.pool.query<{ count: string }>(
          "select count(*) from writing_image_jobs where conversation_id=$1",
          [conversationId],
        );
        if (Number(count.rows[0]?.count) >= 2)
          throw new DomainError("RESOURCE_LIMIT", "本次对话的图片额度已用完");
        const unsettled = await this.pool.query(
          "select 1 from writing_image_jobs where conversation_id=$1 and status in ('unknown','pending') limit 1",
          [conversationId],
        );
        if (unsettled.rowCount)
          throw new DomainError("CONFLICT", "原图片任务结果尚未确认，请先查询或重试保存");
        void key;
      },
      provider: this.capability().available
        ? {
            create: async (input, signal) => {
              const jobId = this.idFor(input.idempotencyKey);
              const response = await fetch(
                `${(this.config.AI_IMAGE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/images/generations`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${this.config.AI_IMAGE_API_KEY}`,
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
                if (bytes > 28_000_000) throw new Error("IMAGE_RESPONSE_LIMIT");
                chunks.push(chunk);
              }
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                data?: { b64_json?: unknown }[];
              };
              const base64 = value.data?.length === 1 ? value.data[0]?.b64_json : undefined;
              if (typeof base64 !== "string" || base64.length > 27_000_000)
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
                "update writing_image_jobs set provider_result=$3,updated_at=now() where id=$1 and conversation_id=$2",
                [input.idempotencyKey, conversationId, JSON.stringify(buffered)],
              );
              return { jobId };
            },
            poll: async (jobId, signal) => {
              const result = await this.pool.query<{ provider_result: BufferedPng | null }>(
                "select provider_result from writing_image_jobs where conversation_id=$1 and id=$2",
                [conversationId, jobId],
              );
              void signal;
              const buffered = result.rows[0]?.provider_result;
              if (!buffered?.base64)
                throw new DomainError("CONFLICT", "图片外部结果未确认，不能重复生成");
              return {
                status: "ready" as const,
                images: [
                  {
                    bytes: Buffer.from(buffered.base64, "base64"),
                    mime: "image/png" as const,
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
        const assetId = this.idFor(key.replace(/:\d+$/, ""));
        await this.storage.put({
          objectKey: this.objectKey(principal, conversationId, assetId),
          bytes: Buffer.from(image.bytes),
          mediaType: image.mime,
          sha256: createHash("sha256").update(image.bytes).digest("hex"),
        });
        return { assetId, mime: image.mime, width: image.width, height: image.height };
      },
    };
    return { ports, jobEvents: () => observed };
  }

  private objectKey(principal: Principal, id: string, assetId: string) {
    return `tenants/${principal.tenantId}/writing/${id}/${assetId}.png`;
  }

  async list(
    tenantId: string,
    conversationId: string,
  ): Promise<{ key: string; runId: string; job: ImageJob }[]> {
    const rows = await this.pool.query<{
      id: string;
      run_id: string;
      status: ImageJob["status"];
      asset_id: string | null;
      provider_result: (ReadyMeta & Partial<BufferedPng>) | null;
    }>(
      `select id,run_id,status,asset_id,provider_result from writing_image_jobs
       where tenant_id=$1 and conversation_id=$2 order by updated_at limit 20`,
      [tenantId, conversationId],
    );
    return rows.rows.flatMap<{ key: string; runId: string; job: ImageJob }>((r) => {
      if (r.status === "ready" && r.asset_id && r.provider_result)
        return [
          {
            key: r.id,
            runId: r.run_id,
            job: {
              id: this.idFor(r.id.replace(/:\d+$/, "")),
              status: "ready" as const,
              assets: [
                {
                  assetId: r.asset_id,
                  mime: r.provider_result.mime,
                  width: r.provider_result.width,
                  height: r.provider_result.height,
                },
              ],
            } satisfies ImageJob,
          },
        ];
      return [
        {
          key: r.id,
          runId: r.run_id,
          job: {
            id: this.idFor(r.id.replace(/:\d+$/, "")),
            status: r.status === "ready" ? "unknown" : r.status,
          } satisfies ImageJob,
        },
      ];
    });
  }

  /** Re-delivers only object storage for an already fetched provider result; never regenerates. */
  async refresh(principal: Principal, conversationId: string, jobKey: string) {
    const result = await this.pool.query<{
      status: ImageJob["status"];
      provider_result: BufferedPng | null;
    }>("select status,provider_result from writing_image_jobs where id=$1 and conversation_id=$2", [
      jobKey,
      conversationId,
    ]);
    const row = result.rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "图片任务不可访问");
    if (row.status !== "pending" || !row.provider_result) return { status: row.status } as const;
    const buffered = row.provider_result;
    if (!this.storage) throw new DomainError("SERVICE_UNAVAILABLE", "私有存储不可用");
    const assetId = this.idFor(jobKey.replace(/:\d+$/, ""));
    await this.storage.put({
      objectKey: this.objectKey(principal, conversationId, assetId),
      bytes: Buffer.from(buffered.base64, "base64"),
      mediaType: "image/png",
      sha256: createHash("sha256").update(buffered.base64).digest("hex"),
    });
    await this.pool.query(
      "update writing_image_jobs set status='ready',asset_id=$3,provider_result=$4,updated_at=now() where id=$1 and conversation_id=$2",
      [
        jobKey,
        conversationId,
        assetId,
        JSON.stringify({ width: buffered.width, height: buffered.height, mime: "image/png" }),
      ],
    );
    return { status: "ready" as const, assetId };
  }

  async access(principal: Principal, conversationId: string, assetId: string) {
    const row = await this.pool.query<{ asset_id: string | null; status: string }>(
      `select asset_id,status from writing_image_jobs
       where conversation_id=$2 and asset_id=$3 and tenant_id=$1`,
      [principal.tenantId, conversationId, assetId],
    );
    const found = row.rows[0];
    if (!found || found.status !== "ready" || !this.storage)
      throw new DomainError("NOT_FOUND", "图片不可访问");
    return {
      url: await this.storage.createReadUrl({
        objectKey: this.objectKey(principal, conversationId, assetId),
        fileName: "生成图片.png",
        mediaType: "image/png",
        expiresIn: this.config.ASSET_ACCESS_URL_TTL_SECONDS,
      }),
      expiresAt: new Date(
        Date.now() + this.config.ASSET_ACCESS_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /** Conversation deletion must also drop job rows (module-owned GC hook). */
  async purgeConversation(
    tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    tenantId: string,
    conversationId: string,
  ) {
    await tx.query("delete from writing_image_jobs where tenant_id=$1 and conversation_id=$2", [
      tenantId,
      conversationId,
    ]);
  }
}
