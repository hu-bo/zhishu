import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const claimsSchema = z
  .object({
    version: z.literal(1),
    audience: z.literal("document-collaboration"),
    tenantId: z.string().min(1).max(128),
    documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/),
    generationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
    schemaVersion: z.number().int().positive(),
    extensions: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            version: z.string().min(1).max(64),
            required: z.boolean(),
          })
          .strict(),
      )
      .max(128),
    subject: z.string().min(1).max(256),
    readOnly: z.boolean(),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type CollaborationSessionClaims = z.infer<typeof claimsSchema>;

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function createSessionTicket(
  input: Omit<CollaborationSessionClaims, "version" | "audience" | "issuedAt" | "expiresAt">,
  secret: string,
  ttlSeconds: number,
  now = Date.now(),
): { token: string; claims: CollaborationSessionClaims } {
  const issuedAt = Math.floor(now / 1000);
  const claims = claimsSchema.parse({
    ...input,
    version: 1,
    audience: "document-collaboration",
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
  });
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${encoded}.${sign(encoded, secret).toString("base64url")}`, claims };
}

export function verifySessionTicket(
  token: string,
  secret: string,
  now = Date.now(),
): CollaborationSessionClaims | null {
  if (token.length > 4096) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;

  let receivedSignature: Buffer;
  try {
    receivedSignature = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  const expectedSignature = sign(encoded, secret);
  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const claims = claimsSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    const nowSeconds = Math.floor(now / 1000);
    if (claims.issuedAt > nowSeconds + 30 || claims.expiresAt <= nowSeconds) return null;
    if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > 900)
      return null;
    return claims;
  } catch {
    return null;
  }
}
