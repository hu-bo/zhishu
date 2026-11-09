import type { FastifyInstance } from "fastify";
import { DomainError } from "../../shared/domain-error.js";
import type { PrincipalAuthenticator } from "./identity.types.js";
import { principalSchema } from "./identity.schema.js";
import { rememberIdentities } from "./identity-directory.js";

export function registerIdentityGuard(app: FastifyInstance, service: PrincipalAuthenticator): void {
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request) => {
    if (request.routeOptions.config.auth === false) return;

    const principal = principalSchema.safeParse(
      await service.authenticate(request.headers.authorization),
    );
    if (!principal.success) throw new DomainError("UNAUTHENTICATED", "Authentication is required");
    await rememberIdentities(app.db, [principal.data]);
    if (!principal.data.active)
      throw new DomainError("UNAUTHENTICATED", "Authentication is required");
    request.principal = principal.data;
  });
}
