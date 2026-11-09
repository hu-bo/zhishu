import { DomainError } from "../../shared/domain-error.js";
import type { Principal } from "./identity.types.js";

export function requirePrincipal(principal: Principal | null | undefined): Principal {
  if (!principal) throw new DomainError("UNAUTHENTICATED", "Authentication is required");
  return principal;
}
