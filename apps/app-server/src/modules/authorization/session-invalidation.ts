import { and, eq, type SQL } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { documents, documentGenerations } from "../../../database/schema/index.js";
import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";

/** Invalidate live authorization after the mutation commits; durable events handle retries. */
export class SessionInvalidator {
  constructor(
    private readonly db: Database,
    private readonly revoker: CollaborationSessionRevoker,
  ) {}

  document(tenantId: string, documentId: string) {
    return this.revoke(tenantId, eq(documents.id, documentId));
  }

  inherited(tenantId: string, workspaceId: string, identityId: string) {
    return this.revoke(
      tenantId,
      and(eq(documents.workspaceId, workspaceId), eq(documents.accessMode, "workspace-inherited"))!,
      identityId,
    );
  }

  private async revoke(tenantId: string, scope: SQL, identityId?: string): Promise<void> {
    const sessions = await this.db
      .select({ documentId: documents.id, generationId: documentGenerations.id })
      .from(documents)
      .innerJoin(
        documentGenerations,
        and(
          eq(documentGenerations.documentId, documents.id),
          eq(documentGenerations.status, "active"),
        ),
      )
      .where(and(eq(documents.tenantId, tenantId), scope));
    for (const session of sessions)
      this.revoker.revokeDocumentSessions(session.documentId, session.generationId, identityId);
  }
}
