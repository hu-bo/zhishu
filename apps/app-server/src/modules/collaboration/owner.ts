import type { DocumentSnapshot, OperationBatch } from "@zhishu/document-contracts";
import type { Principal } from "../identity/identity.types.js";
import type { Database } from "../../../database/index.js";

export type DocumentWriteTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export interface StructureReceipt {
  operationId: string;
  generationId: string;
  durableSeq: number;
  structureRevision: number;
}
export interface CollaborationOwner {
  snapshot(
    principal: Principal,
    documentId: string,
  ): Promise<{
    snapshot: DocumentSnapshot & { generationId: string; durableSeq: number };
    structureRevision: number;
    workspaceId: string;
    title: string;
  }>;
  apply(input: {
    principal: Principal;
    batch: OperationBatch & { generationId: string };
    expectedDurableSeq: number;
    baseStructureRevision: number;
    /** Both hooks run inside the persistence transaction, while the document owner is held. */
    guard: (tx: DocumentWriteTransaction) => Promise<void>;
    record: (tx: DocumentWriteTransaction, receipt: StructureReceipt) => Promise<void>;
  }): Promise<StructureReceipt>;
}
