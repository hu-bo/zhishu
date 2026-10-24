import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "../../shared/domain-error.js";
import type { AiService, StartAiInput } from "./ai.service.js";

export function requireAiPrincipal(request: FastifyRequest) {
  if (!request.principal) throw new DomainError("UNAUTHENTICATED", "请先登录");
  return request.principal;
}
export async function streamAiTask(
  request: FastifyRequest,
  reply: FastifyReply,
  service: AiService,
  body: StartAiInput,
) {
  const principal = requireAiPrincipal(request);
  const started = await service.start(principal, body);
  if (!started.fresh) return reply.send(await service.get(principal, started.run.requestId));
  const controller = new AbortController();
  const disconnected = () => {
    if (!reply.raw.writableFinished) controller.abort("DISCONNECTED");
  };
  reply.raw.once("close", disconnected);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    "x-request-id": request.id,
  });
  const heartbeat = setInterval(() => {
    if (!controller.signal.aborted && reply.raw.writableLength < 65536)
      reply.raw.write(": keep-alive\n\n");
  }, 15000);
  try {
    const events =
      body.request.kind === "authoring"
        ? service.executeDetached(started.run, principal, controller.signal)
        : service.execute(started.run, principal, controller.signal);
    for await (const event of events) {
      if (controller.signal.aborted) break;
      const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      if (!reply.raw.write(frame))
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
  } finally {
    clearInterval(heartbeat);
    reply.raw.removeListener("close", disconnected);
    if (!reply.raw.destroyed) reply.raw.end();
  }
}
