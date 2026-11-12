import type { FastifyInstance } from "fastify";
import { qaSitesRoutes } from "./qa-sites.routes.js";
import { QaSiteService, type QaSiteServiceDeps } from "./qa-site.service.js";

export {
  QaSiteService,
  detachDocumentFromSites,
  type QaSiteServiceDeps,
  type QaSiteRow,
} from "./qa-site.service.js";

export function createQaSiteService(deps: QaSiteServiceDeps): QaSiteService {
  return new QaSiteService(deps);
}

export async function qaSitesModule(
  app: FastifyInstance,
  sites: QaSiteService,
  qa: QaSiteRoutesQa,
) {
  await app.register(async (scope) => qaSitesRoutes(scope, sites, qa));
}

/** Structural type so qa-sites never imports the qa module's full surface. */
export type QaSiteRoutesQa = Parameters<typeof qaSitesRoutes>[2];
