import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed visitor credentials. The cookie binds siteId + visitorId +
 * accessRevision + expiresAt; accessRevision bumps invalidate every issued credential
 * for that site without touching business revisions. Never carries secrets or PII.
 */
export interface VisitorClaims {
  siteId: string;
  visitorId: string;
  accessRevision: number;
  expiresAt: number;
}

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const decode = (value: string): unknown =>
  JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

export function newVisitorId(): string {
  return `visitor_${randomUUID()}`;
}

export function issueVisitorCookie(
  claims: VisitorClaims,
  secret: string,
): { value: string; maxAgeSeconds: number } {
  const payload = encode(claims);
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return {
    value: `${payload}.${signature}`,
    maxAgeSeconds: Math.max(1, Math.floor((claims.expiresAt - Date.now()) / 1000)),
  };
}

export function readVisitorCookie(
  value: string | undefined,
  secret: string,
): VisitorClaims | undefined {
  if (!value) return;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return;
  let claims: VisitorClaims;
  try {
    claims = decode(payload) as VisitorClaims;
  } catch {
    return;
  }
  if (
    typeof claims.siteId !== "string" ||
    typeof claims.visitorId !== "string" ||
    !Number.isSafeInteger(claims.accessRevision) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt < Date.now()
  )
    return;
  return claims;
}

/** scrypt password hash: "scrypt$<salt>$<hash>"; only the hash is stored, never the code. */
export function hashAccessCode(code: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(code, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function verifyAccessCode(code: string, stored: string | null): boolean {
  if (!stored || !code) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "base64");
  const expected = Buffer.from(parts[2]!, "base64");
  const actual = scryptSync(code, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
