import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ZodType } from "zod";
import type { Database } from "../../database/index.js";
import { apiIdempotencyRecords } from "../../database/schema/index.js";
import { DomainError } from "./domain-error.js";

type ReceiptScope = Pick<
  typeof apiIdempotencyRecords.$inferInsert,
  "tenantId" | "subjectId" | "operationId" | "keyHash" | "requestHash"
>;

export function idempotencyScope(
  principal: { tenantId: string; identityId: string },
  operationId: string,
  key: string | undefined,
  input: unknown,
): ReceiptScope | null {
  return key
    ? {
        tenantId: principal.tenantId,
        subjectId: principal.identityId,
        operationId,
        keyHash: createHash("sha256").update(key).digest("hex"),
        requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      }
    : null;
}

/** Call under the operation's transaction lock; receipts are scoped to tenant, actor and operation. */
export async function loadIdempotencyReplay<T>(
  tx: Pick<Database, "select">,
  scope: ReceiptScope | null,
  schema: ZodType<T>,
): Promise<T | null> {
  if (!scope) return null;
  const [record] = await tx
    .select()
    .from(apiIdempotencyRecords)
    .where(
      and(
        eq(apiIdempotencyRecords.tenantId, scope.tenantId),
        eq(apiIdempotencyRecords.subjectId, scope.subjectId),
        eq(apiIdempotencyRecords.operationId, scope.operationId),
        eq(apiIdempotencyRecords.keyHash, scope.keyHash),
      ),
    )
    .limit(1);
  if (!record) return null;
  if (record.requestHash !== scope.requestHash)
    throw new DomainError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已被其它请求使用");
  return schema.parse(record.responseBody);
}

export async function storeIdempotencyReceipt(
  tx: Pick<Database, "insert">,
  scope: ReceiptScope | null,
  responseBody: Record<string, unknown>,
  responseStatus: number,
): Promise<void> {
  if (scope)
    await tx.insert(apiIdempotencyRecords).values({ ...scope, responseBody, responseStatus });
}
