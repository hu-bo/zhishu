import { randomBytes } from "node:crypto";
import { getMockUser, mockUser } from "./mock-user.js";
import type { Principal } from "./identity.types.js";

const bearerTokenPattern = /^Bearer ([A-Za-z0-9_-]+)$/i;

function getBearerToken(authorization: string | undefined): string | undefined {
  return authorization ? bearerTokenPattern.exec(authorization)?.[1] : undefined;
}

export class MockIdentityService {
  private readonly sessions = new Map<string, { expiresAt: number; identityId: string }>();

  constructor(private readonly tokenTtlSeconds: number) {}

  createSession(userId?: string): { accessToken: string; expiresAt: Date; user: Principal } {
    const user = getMockUser(userId) ?? mockUser;
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }

    const accessToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now + this.tokenTtlSeconds * 1000);
    this.sessions.set(accessToken, { expiresAt: expiresAt.getTime(), identityId: user.identityId });
    return { accessToken, expiresAt, user };
  }

  authenticate(authorization: string | undefined): Principal | null {
    const token = getBearerToken(authorization);
    if (!token) return null;

    const session = this.sessions.get(token);
    if (session === undefined) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return getMockUser(session.identityId) ?? mockUser;
  }

  revoke(authorization: string | undefined): void {
    const token = getBearerToken(authorization);
    if (token) this.sessions.delete(token);
  }
}
