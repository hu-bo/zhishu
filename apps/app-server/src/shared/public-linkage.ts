import type { Database } from "../../database/index.js";

type WriteTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Transaction port injected by the root assembly so documents/catalogs/knowledge modules
 * never import qa-sites while still dissolving public-site approvals inside their own
 * ownership-change transactions.
 */
export interface DocumentPublicLinkage {
  detachDocuments(tx: WriteTransaction, tenantId: string, documentIds: string[]): Promise<void>;
}

export type PublicLinkageTransaction = WriteTransaction;
