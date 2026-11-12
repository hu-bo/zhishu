import { Type, type Static } from "@sinclair/typebox";

/**
 * Durable acknowledgement of one applied structure batch. Generic content fact:
 * collaboration persists it, and AI proposal receipts reuse the same identity.
 */
export const StructureReceiptSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1, maxLength: 160 }),
    generationId: Type.String({ minLength: 1, maxLength: 160 }),
    durableSeq: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    structureRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type StructureReceipt = Static<typeof StructureReceiptSchema>;
