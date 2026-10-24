import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  isChatSnapshot,
  isSubmitChatMessage,
  type ChatSnapshot,
  type SubmitChatMessage,
} from "@zhishu/chat-contracts";
import { DshRuntimeError } from "@zhishu/dsh-agent";
import { DomainError } from "../../shared/domain-error.js";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { requireAiPrincipal } from "../ai/ai.controller.js";
import type { WritingService } from "./writing.service.js";
import { isImageJob, type ImageJob } from "@zhishu/ai-plugins/contracts";
const snapshotSchema = z.custom<ChatSnapshot>(isChatSnapshot);
const params = z.object({ conversationId: z.string().min(1).max(160) }).strict();
const runParams = params.extend({ runId: z.string().uuid() });
const submitSchema = z.custom<SubmitChatMessage>(isSubmitChatMessage);
async function command<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof DshRuntimeError)) throw error;
    if (error.code === "NOT_FOUND") throw new DomainError("NOT_FOUND", "对话不存在或无权访问");
    if (error.code === "CONFIGURATION_CHANGED")
      throw new DomainError("CONFLICT", "模型或插件配置已变化，历史仍可读取，请新建写作对话");
    if (["RESOURCE_LIMIT", "QUEUE_FULL", "HISTORY_LIMIT", "BUDGET_EXCEEDED"].includes(error.code))
      throw new DomainError("RESOURCE_LIMIT", "已达到本次对话限制，请稍后重试或开启新对话");
    if (["PERSISTENCE_FAILED", "SESSION_UNAVAILABLE"].includes(error.code))
      throw new DomainError("SERVICE_UNAVAILABLE", "保存暂不可用，请重连后查询原请求");
    throw new DomainError("CONFLICT", "请求与当前对话状态不一致，请刷新后重试", {
      reason: error.code,
    });
  }
}
export async function writingRoutes(app: FastifyInstance, service: WritingService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["writing-chat"],
    security: [{ bearerAuth: [] }],
    response: {
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  };
  typed.get(
    "/capabilities",
    {
      schema: {
        ...common,
        operationId: "getWritingCapabilities",
        response: {
          ...common.response,
          200: z.object({
            enabled: z.boolean(),
            engine: z.literal("dsh-v1"),
            image: z.object({ available: z.boolean(), reason: z.string() }),
          }),
        },
      },
    },
    (request) => {
      requireAiPrincipal(request);
      return service.capabilities();
    },
  );
  typed.post(
    "/conversations",
    {
      schema: {
        ...common,
        operationId: "createWritingConversation",
        body: z
          .object({
            sourceDocumentIds: z
              .array(z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/))
              .max(4)
              .default([]),
          })
          .strict(),
        response: { ...common.response, 200: snapshotSchema },
      },
    },
    (request) =>
      command(() => service.create(requireAiPrincipal(request), request.body.sourceDocumentIds)),
  );
  typed.get(
    "/conversations/:conversationId",
    {
      schema: {
        ...common,
        operationId: "getWritingConversation",
        params,
        response: { ...common.response, 200: snapshotSchema },
      },
    },
    (request) =>
      command(() => service.snapshot(requireAiPrincipal(request), request.params.conversationId)),
  );
  typed.post(
    "/conversations/:conversationId/messages",
    {
      bodyLimit: 65536,
      schema: {
        ...common,
        operationId: "submitWritingMessage",
        params,
        body: submitSchema,
        response: {
          ...common.response,
          202: z.object({ runId: z.string(), snapshot: snapshotSchema }),
        },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await command(() =>
            service.submit(
              requireAiPrincipal(request),
              request.params.conversationId,
              request.body,
            ),
          ),
        ),
  );
  for (const action of ["cancel", "resume"] as const)
    typed.post(
      `/conversations/:conversationId/runs/:runId/${action}`,
      {
        schema: {
          ...common,
          operationId: action === "cancel" ? "cancelWritingRun" : "resumeWritingRun",
          params: runParams,
          response: { ...common.response, 200: snapshotSchema },
        },
      },
      (request) =>
        command(() =>
          service[action](
            requireAiPrincipal(request),
            request.params.conversationId,
            request.params.runId,
          ),
        ),
    );
  typed.post(
    "/conversations/:conversationId/approvals",
    {
      schema: {
        ...common,
        operationId: "decideWritingApproval",
        params,
        body: z
          .object({
            approvalId: z.string().uuid(),
            decisionId: z.string().uuid(),
            decision: z.enum(["allow-once", "reject"]),
          })
          .strict(),
        response: { ...common.response, 200: snapshotSchema },
      },
    },
    (request) =>
      command(() =>
        service.decide(requireAiPrincipal(request), request.params.conversationId, request.body),
      ),
  );
  const imageJob = z.custom<ImageJob>(isImageJob);
  typed.get(
    "/conversations/:conversationId/images",
    {
      schema: {
        ...common,
        operationId: "listWritingImages",
        params,
        response: { ...common.response, 200: z.array(imageJob) },
      },
    },
    (request) => service.imageList(requireAiPrincipal(request), request.params.conversationId),
  );
  typed.post(
    "/conversations/:conversationId/images/:jobId/refresh",
    {
      schema: {
        ...common,
        operationId: "refreshWritingImage",
        params: params.extend({ jobId: z.string().min(1).max(200) }),
        response: { ...common.response, 200: imageJob },
      },
    },
    (request) =>
      service.imageRefresh(
        requireAiPrincipal(request),
        request.params.conversationId,
        request.params.jobId,
      ),
  );
  typed.get(
    "/conversations/:conversationId/images/:assetId/access",
    {
      schema: {
        ...common,
        operationId: "getWritingImageAccess",
        params: params.extend({ assetId: z.string().regex(/^image_[a-f0-9]{48}$/) }),
        response: {
          ...common.response,
          200: z.object({ url: z.string().url(), expiresAt: z.string().datetime() }),
        },
      },
    },
    (request) =>
      service.imageAccess(
        requireAiPrincipal(request),
        request.params.conversationId,
        request.params.assetId,
      ),
  );
  typed.get(
    "/conversations/:conversationId/events",
    {
      schema: {
        ...common,
        operationId: "observeWritingConversation",
        params,
        querystring: z.object({
          cursor: z
            .string()
            .regex(/^(0|[1-9][0-9]*)$/)
            .max(20)
            .default("0"),
        }),
        response: { ...common.response, 200: z.string() },
      },
    },
    async (request, reply) => {
      const principal = requireAiPrincipal(request),
        id = request.params.conversationId;
      await command(() => service.snapshot(principal, id));
      const stop = new AbortController();
      const disconnect = () => stop.abort();
      reply.raw.once("close", disconnect);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      });
      reply.raw.write(": connected\n\n");
      const heartbeat = setInterval(() => {
        if (!stop.signal.aborted && reply.raw.writableLength < 65536)
          reply.raw.write(": heartbeat\n\n");
      }, 15000);
      try {
        for await (const frame of service.observe(
          principal,
          id,
          request.query.cursor,
          stop.signal,
        )) {
          if (stop.signal.aborted) break;
          if (reply.raw.writableLength > 262144) {
            stop.abort();
            break;
          }
          const data = `${frame.type === "snapshot" ? `id: ${frame.sequence}\n` : ""}data: ${JSON.stringify(frame)}\n\n`;
          if (!reply.raw.write(data))
            await new Promise<void>((resolve) => {
              const done = () => {
                reply.raw.removeListener("drain", done);
                reply.raw.removeListener("close", done);
                resolve();
              };
              reply.raw.once("drain", done);
              reply.raw.once("close", done);
            });
        }
      } catch {
        if (!reply.raw.destroyed)
          reply.raw.write(
            `data: ${JSON.stringify({ type: "resync-required", conversationId: id })}\n\n`,
          );
      } finally {
        stop.abort();
        clearInterval(heartbeat);
        reply.raw.removeListener("close", disconnect);
        if (!reply.raw.destroyed) reply.raw.end();
      }
    },
  );
}
