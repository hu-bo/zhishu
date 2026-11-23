import {
  AuthServiceError,
  createAuthServiceClient,
  type AuthServiceIdentity,
} from "@nova/casdoor/server/auth-service";
import type { AppConfig } from "../../config.js";
import { DomainError } from "../../shared/domain-error.js";
import { getBearerToken } from "./identity.service.js";
import type { Principal, PrincipalAuthenticator } from "./identity.types.js";

/**
 * Baseline role for every verified identity. Workspace and document capabilities
 * come only from the existing ACL model; Auth Service groups never grant access
 * directly (per the 2026-11 deployment decision, and matching nova's rule that
 * UI roles are not an authorization source).
 */
export const AUTH_SERVICE_BASELINE_ROLES: readonly string[] = Object.freeze(["user"]);

/** The SDK surface this adapter consumes; kept narrow so tests inject a stub. */
export interface VerifiedIdentityVerifier {
  verifyAccessToken(token: string): Promise<AuthServiceIdentity>;
}

export type AuthServiceConfigFields = Pick<
  AppConfig,
  "AUTH_SERVICE_URL" | "AUTH_SERVICE_TOKEN_TRANSPORT" | "AUTH_SERVICE_TIMEOUT_MS"
>;

/**
 * Maps a verified Auth Service identity onto a Zhishu principal. The identity id
 * is the Casdoor "organization/name" key: the organization is the data-isolation
 * domain (`tenantId`, same slot as the mock "local"), the name is the username.
 * The Auth Service profile carries no email; the directory keys on displayName.
 */
export function principalFromVerifiedIdentity(identity: AuthServiceIdentity): Principal {
  const separator = identity.identityId.indexOf("/");
  const organization =
    separator > 0 ? identity.identityId.slice(0, separator) : identity.identityId;
  const username = separator > 0 ? identity.identityId.slice(separator + 1) : identity.identityId;
  return {
    identityId: identity.identityId,
    tenantId: organization,
    username,
    displayName: identity.displayName || username,
    email: "",
    globalRoles: AUTH_SERVICE_BASELINE_ROLES,
    active: identity.active,
  };
}

export class AuthServiceIdentityService implements PrincipalAuthenticator {
  constructor(private readonly verifier: VerifiedIdentityVerifier) {}

  // AUTH_SERVICE_URL carries a schema default (http://auth.8and1.cn), so a typed
  // config always provides a usable origin; no runtime guard needed here.
  static fromConfig(config: AuthServiceConfigFields): AuthServiceIdentityService {
    return new AuthServiceIdentityService(
      createAuthServiceClient({
        // The URL is the service origin; the SDK protocol lives under /api.
        authApiBase: `${config.AUTH_SERVICE_URL.replace(/\/+$/, "")}/api`,
        tokenTransport: config.AUTH_SERVICE_TOKEN_TRANSPORT,
        timeoutMs: config.AUTH_SERVICE_TIMEOUT_MS,
      }),
    );
  }

  /**
   * Every request revalidates against the Auth Service (no token cache), matching
   * nova's revocation semantics: upstream bans and deletions take effect at once.
   * Invalid credentials authenticate as null (401 via the guard); transport or
   * response failures surface as 503 so stale data is never treated as trusted.
   */
  async authenticate(authorization: string | undefined): Promise<Principal | null> {
    const token = getBearerToken(authorization);
    if (!token) return null;
    try {
      return principalFromVerifiedIdentity(await this.verifier.verifyAccessToken(token));
    } catch (error) {
      if (error instanceof AuthServiceError) {
        if (error.code === "INVALID_TOKEN") return null;
        throw new DomainError("SERVICE_UNAVAILABLE", "身份服务暂时不可用，请稍后重试。");
      }
      throw error;
    }
  }
}
