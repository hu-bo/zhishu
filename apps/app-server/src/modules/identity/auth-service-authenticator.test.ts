import test from "node:test";
import assert from "node:assert/strict";
import { AuthServiceError, type AuthServiceIdentity } from "@nova/casdoor/server/auth-service";
import {
  AUTH_SERVICE_BASELINE_ROLES,
  AuthServiceIdentityService,
  principalFromVerifiedIdentity,
  type AuthServiceConfigFields,
} from "./auth-service-authenticator.js";
import { DomainError } from "../../shared/domain-error.js";

function verifiedIdentity(overrides: Partial<AuthServiceIdentity> = {}): AuthServiceIdentity {
  return {
    identityId: "zhishu/alice",
    displayName: "Alice",
    roles: ["user"],
    active: true,
    ...overrides,
  };
}

function stubVerifier(result: "valid" | "invalid" | "unavailable", signal?: () => void) {
  return {
    async verifyAccessToken(token: string) {
      if (token === "jwt.with.dots" && result === "valid") {
        signal?.();
        return verifiedIdentity();
      }
      signal?.();
      throw new AuthServiceError(result === "invalid" ? "INVALID_TOKEN" : "UNAVAILABLE");
    },
  };
}

test("maps an Auth Service identity onto the baseline Zhishu principal", () => {
  const principal = principalFromVerifiedIdentity(verifiedIdentity());
  assert.deepEqual(principal, {
    identityId: "zhishu/alice",
    tenantId: "zhishu",
    username: "alice",
    displayName: "Alice",
    email: "",
    globalRoles: AUTH_SERVICE_BASELINE_ROLES,
    active: true,
  });
});

test("tolerates identity ids without an organization separator", () => {
  const principal = principalFromVerifiedIdentity(
    verifiedIdentity({ identityId: "solo", displayName: "" }),
  );
  assert.equal(principal.tenantId, "solo");
  assert.equal(principal.username, "solo");
  assert.equal(principal.displayName, "solo");
});

test("keeps every IdP role out of globalRoles", () => {
  const principal = principalFromVerifiedIdentity(
    verifiedIdentity({ roles: ["admin", "root", "editor"] }),
  );
  assert.deepEqual(principal.globalRoles, ["user"]);
});

test("carries the inactive flag through for the guard to reject", () => {
  assert.equal(principalFromVerifiedIdentity(verifiedIdentity({ active: false })).active, false);
});

test("authenticates JWT-bearing bearer headers with dots", async () => {
  let seen = false;
  const service = new AuthServiceIdentityService(
    stubVerifier("valid", () => {
      seen = true;
    }),
  );
  const principal = await service.authenticate("Bearer jwt.with.dots");
  assert.ok(principal);
  assert.equal(principal.identityId, "zhishu/alice");
  assert.equal(seen, true);
});

test("missing and invalid credentials authenticate as null; upstream failures surface as 503", async () => {
  assert.equal(
    await new AuthServiceIdentityService(stubVerifier("valid")).authenticate(undefined),
    null,
  );
  assert.equal(
    await new AuthServiceIdentityService(stubVerifier("valid")).authenticate("Token x"),
    null,
  );
  assert.equal(
    await new AuthServiceIdentityService(stubVerifier("invalid")).authenticate(
      "Bearer jwt.with.dots",
    ),
    null,
  );
  await assert.rejects(
    () =>
      new AuthServiceIdentityService(stubVerifier("unavailable")).authenticate(
        "Bearer jwt.with.dots",
      ),
    (error: unknown) => error instanceof DomainError && error.code === "SERVICE_UNAVAILABLE",
  );
});

const baseConfig: AuthServiceConfigFields = {
  AUTH_SERVICE_URL: "https://auth.example.test/",
  AUTH_SERVICE_TOKEN_TRANSPORT: "query",
  AUTH_SERVICE_TIMEOUT_MS: 5000,
};

test("fromConfig requires AUTH_SERVICE_URL and normalizes the /api base", () => {
  assert.throws(
    () => AuthServiceIdentityService.fromConfig({ ...baseConfig, AUTH_SERVICE_URL: undefined }),
    /AUTH_MODE=external requires AUTH_SERVICE_URL/,
  );
  // A valid construction proves the trailing slash folds into ${url}/api without doubling.
  assert.ok(AuthServiceIdentityService.fromConfig(baseConfig));
});
