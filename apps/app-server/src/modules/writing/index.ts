import type { FastifyInstance } from "fastify";
import { writingRoutes } from "./writing.routes.js";
import { WritingService, type WritingServiceDeps } from "./writing.service.js";

export { WritingService, type WritingServiceDeps } from "./writing.service.js";
export { WritingImages } from "./writing.images.js";
export { nativeSessionIdFor, parseNativeSessionId } from "./writing.native.js";

export function createWritingService(deps: WritingServiceDeps): WritingService {
  return new WritingService(deps);
}

export async function writingModule(app: FastifyInstance, writing: WritingService) {
  await app.register(async (scope) => writingRoutes(scope, writing), { prefix: "/ai" });
}
