import type { FastifyInstance } from "fastify";
import { qaRoutes } from "./qa.routes.js";
import { QaService, type QaServiceDeps } from "./qa.service.js";

export {
  QaService,
  type QaAudience,
  type QaSubmitInput,
  type QaServiceDeps,
} from "./qa.service.js";

/** QA assembly: shared store + trusted retrieval + ai-qa flow; routes under /api/ai/qa. */
export function createQaService(deps: QaServiceDeps): QaService {
  return new QaService(deps);
}

export async function qaModule(app: FastifyInstance, qa: QaService) {
  await app.register(async (scope) => qaRoutes(scope, qa), { prefix: "/ai" });
}
