import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type { ImageAsset, ImageJob } from "./contracts.js";
import type {} from "@deepseek-ai/dsh-session";
export interface ImagePorts {
  load(key: string): Promise<ImageJob | undefined>;
  save(key: string, job: ImageJob): Promise<void>;
  reserve(key: string, signal: AbortSignal): Promise<void>;
  provider?: {
    create(
      input: { prompt: string; idempotencyKey: string },
      signal: AbortSignal,
    ): Promise<{ jobId: string }>;
    poll(
      jobId: string,
      signal: AbortSignal,
    ): Promise<
      | { status: "pending" | "failed" }
      | {
          status: "ready";
          images: readonly {
            bytes: Uint8Array;
            mime: ImageAsset["mime"];
            width: number;
            height: number;
          }[];
        }
    >;
    cancel?(jobId: string, signal: AbortSignal): Promise<void>;
  };
  store(
    key: string,
    image: { bytes: Uint8Array; mime: ImageAsset["mime"]; width: number; height: number },
    signal: AbortSignal,
  ): Promise<ImageAsset>;
}
export function installImage(ctx: Context, ports: ImagePorts) {
  if (!ports.provider) return { available: false as const, reason: "图片服务尚未配置" };
  const provider = ports.provider;
  ctx.tools.register({
    name: "create_image",
    description: "创建一张图片，保存至私有资源库。",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", minLength: 1, maxLength: 4000 } },
      required: ["prompt"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { jobId: { type: "string" }, status: { type: "string" } },
        required: ["jobId", "status"],
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
    },
    async execute(args, exec) {
      const key = `${exec.agent?.id}:${exec.callId}`;
      let job = await ports.load(key);
      if (job?.status === "unknown") throw new Error("IMAGE_OUTCOME_UNKNOWN");
      if (!job) {
        await ports.reserve(key, exec.signal);
        if (!exec.agent) throw new Error("AGENT_REQUIRED");
        // Persist the one-shot approval audit before any billable dispatch.
        await ctx.sessions.flush(exec.agent.session);
        await ports.save(key, { id: key, status: "unknown" });
        const created = await provider.create(
          { prompt: (args as { prompt: string }).prompt, idempotencyKey: key },
          exec.signal,
        );
        job = { id: created.jobId, status: "pending" };
        await ports.save(key, job);
      }
      if (job.status === "pending") {
        const result = await provider.poll(job.id, exec.signal);
        if (result.status === "ready") {
          const assets: ImageAsset[] = [];
          for (const [i, image] of result.images.entries()) {
            if (
              result.images.length !== 1 ||
              image.bytes.byteLength > 20000000 ||
              image.width <= 0 ||
              image.height <= 0
            )
              throw new Error("INVALID_IMAGE");
            assets.push(await ports.store(`${key}:${i}`, image, exec.signal));
          }
          job = { id: job.id, status: "ready", assets };
        } else job = { id: job.id, status: result.status };
        await ports.save(key, job);
      }
      return { jobId: job.id, status: job.status };
    },
  });
  return { available: true as const };
}
