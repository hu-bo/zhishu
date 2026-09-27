import { randomBytes } from "node:crypto";
import { mockUser } from "./mock-user.js";
import type { Principal } from "./identity.types.js";

const bearerTokenPattern = /^Bearer ([A-Za-z0-9_-]+)$/i;

function getBearerToken(authorization: string | undefined): string | undefined {
  return authorization ? bearerTokenPattern.exec(authorization)?.[1] : undefined;
}

export class MockIdentityService {
  private readonly sessions = new Map<string, number>();

  constructor(private readonly tokenTtlSeconds: number) {}

  createSession(): { accessToken: string; expiresAt: Date; user: Principal } {
    const now = Date.now();
    for (const [token, expiry] of this.sessions) {
      if (expiry <= now) this.sessions.delete(token);
    }

    const accessToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now + this.tokenTtlSeconds * 1000);
    this.sessions.set(accessToken, expiresAt.getTime());
    return { accessToken, expiresAt, user: mockUser };
  }

  authenticate(authorization: string | undefined): Principal | null {
    const token = getBearerToken(authorization);
    if (!token) return null;

    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return null;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return mockUser;
  }

  revoke(authorization: string | undefined): void {
    const token = getBearerToken(authorization);
    if (token) this.sessions.delete(token);
  }
}
