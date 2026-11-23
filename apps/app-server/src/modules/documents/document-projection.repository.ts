import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { documentOutbox, documentProjectionSnapshots } from "../../../database/schema/index.js";
import type { DocumentContent } from "@zhishu/document-contracts";
import {
  hashDocumentContent,
  summarizeDocumentContent,
  type ProjectionSummary,
} from "./document-content.js";
const emptyDocumentContent: DocumentContent = { type: "doc", content: [] };

const PROJECTION_RETRY_MAX_MS = 5 * 60_000;

const PROJECTION_RETRY_BASE_MS = 1_000;

const PROJECTION_MAX_ATTEMPTS = 8;

const PROJECTION_LEASE_MS = 30_000;

export async function insertEmptyProjectionSnapshot(
  executor: Pick<Database, "insert">,
  input: { tenantId: string; documentId: string; generationId: string },
): Promise<void> {
  await executor.insert(documentProjectionSnapshots).values({
    ...input,
    durableSeq: 0,
    snapshotRevision: 1,
    content: emptyDocumentContent,
    contentHash: hashDocumentContent(emptyDocumentContent),
    ...summarizeDocumentContent(emptyDocumentContent),
  });
}

export async function insertProjectionOutbox(
  executor: ProjectionOutboxExecutor,
  input: {
    tenantId: string;
    documentId: string;
    generationId: string;
    durableSeq: number;
    updateHash: string;
    contentChanged: boolean;
    content: DocumentContent;
  },
): Promise<void> {
  await executor.insert(documentOutbox).values({
    tenantId: input.tenantId,
    documentId: input.documentId,
    generationId: input.generationId,
    durableSeq: input.durableSeq,
    updateHash: input.updateHash,
    contentChanged: input.contentChanged,
    summary: summarizeDocumentContent(input.content),
    snapshotContent: input.content,
    contentHash: hashDocumentContent(input.content),
  });
  await executor
    .update(documentOutbox)
    .set({
      status: "done",
      processedAt: sql`CURRENT_TIMESTAMP`,
      leaseUntil: null,
      leaseToken: null,
      snapshotContent: null,
    })
    .where(
      and(
        eq(documentOutbox.generationId, input.generationId),
        sql`${documentOutbox.durableSeq} < ${input.durableSeq}`,
        or(eq(documentOutbox.status, "pending"), eq(documentOutbox.status, "processing")),
      ),
    );
}

type ProjectionOutboxExecutor = Pick<Database, "insert" | "update">;

export type ClaimedProjectionJob = {
  id: string;
  leaseToken: string;
  tenantId: string;
  documentId: string;
  generationId: string;
  durableSeq: number;
  content: DocumentContent;
  contentHash: string;
  summary: ProjectionSummary;
};

/** Owns projection leases, monotonic publication, retries and repair. */
export class DocumentProjectionRepository {
  constructor(private readonly db: Database) {}
  async claimProjectionJob(
    now = new Date(),
    documentId?: string,
  ): Promise<ClaimedProjectionJob | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(documentOutbox)
        .where(
          and(
            or(
              and(eq(documentOutbox.status, "pending"), lte(documentOutbox.availableAt, now)),
              and(eq(documentOutbox.status, "processing"), lte(documentOutbox.leaseUntil, now)),
            ),
            ...(documentId ? [eq(documentOutbox.documentId, documentId)] : []),
          ),
        )
        .orderBy(asc(documentOutbox.availableAt), asc(documentOutbox.createdAt))
        .for("update", { skipLocked: true })
        .limit(1);
      if (!row) return null;

      const leaseToken = randomUUID();
      const [claimed] = await tx
        .update(documentOutbox)
        .set({
          status: "processing",
          attempts: row.attempts + 1,
          leaseUntil: new Date(now.getTime() + PROJECTION_LEASE_MS),
          leaseToken,
        })
        .where(eq(documentOutbox.id, row.id))
        .returning();
      if (!claimed) return null;
      if (!claimed.snapshotContent || !claimed.contentHash) {
        await tx
          .update(documentOutbox)
          .set({
            status: "dead",
            leaseUntil: null,
            leaseToken: null,
            lastErrorCode: "snapshot-payload-missing",
          })
          .where(eq(documentOutbox.id, claimed.id));
        return null;
      }
      return {
        id: claimed.id,
        leaseToken,
        tenantId: claimed.tenantId,
        documentId: claimed.documentId,
        generationId: claimed.generationId,
        durableSeq: claimed.durableSeq,
        content: claimed.snapshotContent,
        contentHash: claimed.contentHash,
        summary: claimed.summary,
      };
    });
  }

  async processProjectionJob(job: ClaimedProjectionJob, now = new Date()): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .select({ id: documentOutbox.id })
        .from(documentOutbox)
        .where(
          and(
            eq(documentOutbox.id, job.id),
            eq(documentOutbox.leaseToken, job.leaseToken),
            eq(documentOutbox.status, "processing"),
          ),
        )
        .for("update")
        .limit(1);
      if (!claimed) return false;

      await tx
        .insert(documentProjectionSnapshots)
        .values({
          tenantId: job.tenantId,
          documentId: job.documentId,
          generationId: job.generationId,
          durableSeq: job.durableSeq,
          snapshotRevision: 1,
          content: job.content,
          contentHash: job.contentHash,
          ...job.summary,
          projectedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            documentProjectionSnapshots.tenantId,
            documentProjectionSnapshots.documentId,
            documentProjectionSnapshots.generationId,
          ],
          set: {
            durableSeq: job.durableSeq,
            snapshotRevision: sql`${documentProjectionSnapshots.snapshotRevision} + 1`,
            content: job.content,
            contentHash: job.contentHash,
            ...job.summary,
            projectedAt: now,
          },
          setWhere: sql`${documentProjectionSnapshots.durableSeq} < ${job.durableSeq}`,
        });
      await tx
        .update(documentOutbox)
        .set({
          status: "done",
          processedAt: now,
          leaseUntil: null,
          leaseToken: null,
          snapshotContent: null,
        })
        .where(eq(documentOutbox.id, job.id));
      return true;
    });
  }

  async failProjectionJob(
    job: Pick<ClaimedProjectionJob, "id" | "leaseToken">,
    errorCode = "projection-persist-failed",
    now = new Date(),
  ): Promise<"retry" | "dead" | "stale"> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ attempts: documentOutbox.attempts })
        .from(documentOutbox)
        .where(
          and(
            eq(documentOutbox.id, job.id),
            eq(documentOutbox.leaseToken, job.leaseToken),
            eq(documentOutbox.status, "processing"),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return "stale";

      if (row.attempts >= PROJECTION_MAX_ATTEMPTS) {
        await tx
          .update(documentOutbox)
          .set({
            status: "dead",
            leaseUntil: null,
            leaseToken: null,
            lastErrorCode: errorCode,
          })
          .where(eq(documentOutbox.id, job.id));
        return "dead";
      }
      const delay = Math.min(
        PROJECTION_RETRY_BASE_MS * 2 ** Math.max(0, row.attempts - 1),
        PROJECTION_RETRY_MAX_MS,
      );
      await tx
        .update(documentOutbox)
        .set({
          status: "pending",
          availableAt: new Date(now.getTime() + delay),
          leaseUntil: null,
          leaseToken: null,
          lastErrorCode: errorCode,
        })
        .where(eq(documentOutbox.id, job.id));
      return "retry";
    });
  }

  async backfillProjectionSnapshot(input: {
    tenantId: string;
    documentId: string;
    generationId: string;
    durableSeq: number;
    content: DocumentContent;
    projectedAt?: Date;
  }): Promise<boolean> {
    const projectedAt = input.projectedAt ?? new Date();
    const contentHash = hashDocumentContent(input.content);
    const summary = summarizeDocumentContent(input.content);
    const [row] = await this.db
      .insert(documentProjectionSnapshots)
      .values({
        tenantId: input.tenantId,
        documentId: input.documentId,
        generationId: input.generationId,
        durableSeq: input.durableSeq,
        snapshotRevision: 1,
        content: input.content,
        contentHash,
        ...summary,
        projectedAt,
      })
      .onConflictDoUpdate({
        target: [
          documentProjectionSnapshots.tenantId,
          documentProjectionSnapshots.documentId,
          documentProjectionSnapshots.generationId,
        ],
        set: {
          durableSeq: input.durableSeq,
          snapshotRevision: sql`${documentProjectionSnapshots.snapshotRevision} + 1`,
          content: input.content,
          contentHash,
          ...summary,
          projectedAt,
        },
        setWhere: sql`${documentProjectionSnapshots.durableSeq} < ${input.durableSeq}`,
      })
      .returning({ durableSeq: documentProjectionSnapshots.durableSeq });
    return row !== undefined;
  }

  async getProjectionQueueStatus(
    documentId?: string,
  ): Promise<{ pending: number; processing: number; dead: number }> {
    const query = this.db
      .select({
        pending: sql<number>`count(*) filter (where ${documentOutbox.status} = 'pending')::int`,
        processing: sql<number>`count(*) filter (where ${documentOutbox.status} = 'processing')::int`,
        dead: sql<number>`count(*) filter (where ${documentOutbox.status} = 'dead')::int`,
      })
      .from(documentOutbox);
    const [row] = documentId
      ? await query.where(eq(documentOutbox.documentId, documentId))
      : await query;
    return row ?? { pending: 0, processing: 0, dead: 0 };
  }
}
