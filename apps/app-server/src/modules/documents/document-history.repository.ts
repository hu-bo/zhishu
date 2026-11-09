import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  documents,
  documentGenerations,
  documentVersions,
  documentGenerationCheckpoints,
  documentVersionCheckpoints,
  collaborationUpdates,
} from "../../../database/schema/index.js";
const yjsReplayPageSize = 16;

export type VersionCheckpointInput = {
  versionId: string;
  durableSeq: number;
  stateBytes: Uint8Array;
};

export type YjsCompactionTarget = {
  documentId: string;
  generationId: string;
  durableSeq: number;
  checkpointSeq: number | null;
};

export type PersistedUpdate = {
  updateHash: string;
  updateBytes: Uint8Array;
  durableSeq: number;
};

/** Owns checkpoint selection, contiguous replay and safe history compaction. */
export class DocumentHistoryRepository {
  constructor(private readonly db: Database) {}
  async replayYjsState(
    input: {
      documentId: string;
      generationId: string;
      targetSeq: number;
      versionId?: string;
    },
    applyUpdate: (updateBytes: Uint8Array, durableSeq: number) => void,
    onAppliedSeq?: (durableSeq: number) => void,
  ): Promise<{ checkpointSeq: number }> {
    let checkpointSeq = 0;
    let checkpointBytes: Buffer | undefined;
    if (input.versionId) {
      const [snapshot] = await this.db
        .select({
          stateBytes: documentVersionCheckpoints.stateBytes,
          stateHash: documentVersionCheckpoints.stateHash,
        })
        .from(documentVersionCheckpoints)
        .innerJoin(documentVersions, eq(documentVersions.id, documentVersionCheckpoints.versionId))
        .where(
          and(
            eq(documentVersionCheckpoints.versionId, input.versionId),
            eq(documentVersions.documentId, input.documentId),
            eq(documentVersions.generationId, input.generationId),
            eq(documentVersions.durableSeq, input.targetSeq),
          ),
        )
        .limit(1);
      if (snapshot) {
        if (createHash("sha256").update(snapshot.stateBytes).digest("hex") !== snapshot.stateHash) {
          throw new Error("Version checkpoint checksum does not match");
        }
        checkpointSeq = input.targetSeq;
        checkpointBytes = snapshot.stateBytes;
      }
    }
    if (!checkpointBytes) {
      const [checkpoint] = await this.db
        .select({
          durableSeq: documentGenerationCheckpoints.durableSeq,
          stateBytes: documentGenerationCheckpoints.stateBytes,
          stateHash: documentGenerationCheckpoints.stateHash,
        })
        .from(documentGenerationCheckpoints)
        .where(
          and(
            eq(documentGenerationCheckpoints.documentId, input.documentId),
            eq(documentGenerationCheckpoints.generationId, input.generationId),
            lte(documentGenerationCheckpoints.durableSeq, input.targetSeq),
          ),
        )
        .limit(1);
      if (checkpoint) {
        if (
          createHash("sha256").update(checkpoint.stateBytes).digest("hex") !== checkpoint.stateHash
        ) {
          throw new Error("Generation checkpoint checksum does not match");
        }
        checkpointSeq = checkpoint.durableSeq;
        checkpointBytes = checkpoint.stateBytes;
      }
    }

    if (checkpointSeq > input.targetSeq) throw new Error("Yjs checkpoint is newer than the target");
    if (checkpointBytes) applyUpdate(new Uint8Array(checkpointBytes), checkpointSeq);
    onAppliedSeq?.(checkpointSeq);

    let nextSeq = checkpointSeq + 1;
    while (nextSeq <= input.targetSeq) {
      const rows = await this.db
        .select({
          durableSeq: collaborationUpdates.durableSeq,
          updateBytes: collaborationUpdates.updateBytes,
        })
        .from(collaborationUpdates)
        .where(
          and(
            eq(collaborationUpdates.documentId, input.documentId),
            eq(collaborationUpdates.generationId, input.generationId),
            gte(collaborationUpdates.durableSeq, nextSeq),
            lte(collaborationUpdates.durableSeq, input.targetSeq),
          ),
        )
        .orderBy(asc(collaborationUpdates.durableSeq))
        .limit(yjsReplayPageSize);
      if (rows.length === 0)
        throw new Error(`Yjs update history is incomplete at sequence ${nextSeq}`);
      for (const row of rows) {
        if (row.durableSeq !== nextSeq || !row.updateBytes) {
          throw new Error(`Yjs update history is incomplete at sequence ${nextSeq}`);
        }
        const updateBytes = new Uint8Array(row.updateBytes);
        applyUpdate(updateBytes, row.durableSeq);
        onAppliedSeq?.(row.durableSeq);
        nextSeq += 1;
      }
    }
    if (nextSeq - 1 !== input.targetSeq) {
      throw new Error("Yjs update history does not reach the requested sequence");
    }
    return { checkpointSeq };
  }

  async listYjsCompactionTargets(): Promise<YjsCompactionTarget[]> {
    const rows = await this.db
      .select({
        documentId: documentGenerations.documentId,
        generationId: documentGenerations.id,
        durableSeq: documentGenerations.durableSeq,
        checkpointSeq: documentGenerationCheckpoints.durableSeq,
      })
      .from(documentGenerations)
      .leftJoin(
        documentGenerationCheckpoints,
        and(
          eq(documentGenerationCheckpoints.documentId, documentGenerations.documentId),
          eq(documentGenerationCheckpoints.generationId, documentGenerations.id),
        ),
      )
      .orderBy(asc(documentGenerations.documentId), asc(documentGenerations.createdAt));
    return rows;
  }

  async listVersionsNeedingCheckpoint(
    generationId: string,
    throughSeq: number,
  ): Promise<Array<{ versionId: string; durableSeq: number }>> {
    return this.db
      .select({ versionId: documentVersions.id, durableSeq: documentVersions.durableSeq })
      .from(documentVersions)
      .leftJoin(
        documentVersionCheckpoints,
        eq(documentVersionCheckpoints.versionId, documentVersions.id),
      )
      .where(
        and(
          eq(documentVersions.generationId, generationId),
          lte(documentVersions.durableSeq, throughSeq),
          isNull(documentVersionCheckpoints.versionId),
        ),
      )
      .orderBy(asc(documentVersions.durableSeq), asc(documentVersions.id));
  }

  async commitYjsCheckpoints(input: {
    documentId: string;
    generationId: string;
    durableSeq: number;
    stateBytes: Uint8Array;
    versionCheckpoints: readonly VersionCheckpointInput[];
  }): Promise<
    | { status: "not-found" | "conflict" | "stale" }
    | { status: "compacted"; prunedUpdates: number; prunedBytes: number; versionSnapshots: number }
  > {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, input.documentId))
        .for("update")
        .limit(1);
      if (!document) return { status: "not-found" };

      const [generation] = await tx
        .select({ durableSeq: documentGenerations.durableSeq })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.id, input.generationId),
          ),
        )
        .for("update")
        .limit(1);
      if (!generation) return { status: "not-found" };
      if (generation.durableSeq !== input.durableSeq) return { status: "conflict" };

      const [existingCheckpoint] = await tx
        .select({ durableSeq: documentGenerationCheckpoints.durableSeq })
        .from(documentGenerationCheckpoints)
        .where(
          and(
            eq(documentGenerationCheckpoints.documentId, input.documentId),
            eq(documentGenerationCheckpoints.generationId, input.generationId),
          ),
        )
        .limit(1);
      if (existingCheckpoint && existingCheckpoint.durableSeq > input.durableSeq) {
        return { status: "conflict" };
      }

      const suppliedSnapshots = new Map(
        input.versionCheckpoints.map((checkpoint) => [checkpoint.versionId, checkpoint]),
      );
      const missingVersions = await tx
        .select({ versionId: documentVersions.id })
        .from(documentVersions)
        .leftJoin(
          documentVersionCheckpoints,
          eq(documentVersionCheckpoints.versionId, documentVersions.id),
        )
        .where(
          and(
            eq(documentVersions.generationId, input.generationId),
            lte(documentVersions.durableSeq, input.durableSeq),
            isNull(documentVersionCheckpoints.versionId),
          ),
        );
      if (missingVersions.some((version) => !suppliedSnapshots.has(version.versionId))) {
        return { status: "stale" };
      }
      if (input.versionCheckpoints.length > 0) {
        const validVersions = await tx
          .select({ id: documentVersions.id, durableSeq: documentVersions.durableSeq })
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.generationId, input.generationId),
              lte(documentVersions.durableSeq, input.durableSeq),
              inArray(
                documentVersions.id,
                input.versionCheckpoints.map((item) => item.versionId),
              ),
            ),
          );
        if (
          validVersions.length !== input.versionCheckpoints.length ||
          input.versionCheckpoints.some(
            (snapshot) =>
              validVersions.find((version) => version.id === snapshot.versionId)?.durableSeq !==
              snapshot.durableSeq,
          )
        ) {
          return { status: "stale" };
        }
      }

      const createdAt = new Date();
      if (input.versionCheckpoints.length > 0) {
        await tx
          .insert(documentVersionCheckpoints)
          .values(
            input.versionCheckpoints.map((checkpoint) => ({
              versionId: checkpoint.versionId,
              stateBytes: Buffer.from(checkpoint.stateBytes),
              stateHash: createHash("sha256").update(checkpoint.stateBytes).digest("hex"),
              createdAt,
            })),
          )
          .onConflictDoNothing();
      }
      const stateHash = createHash("sha256").update(input.stateBytes).digest("hex");
      await tx
        .insert(documentGenerationCheckpoints)
        .values({
          documentId: input.documentId,
          generationId: input.generationId,
          durableSeq: input.durableSeq,
          stateBytes: Buffer.from(input.stateBytes),
          stateHash,
          createdAt,
        })
        .onConflictDoUpdate({
          target: [
            documentGenerationCheckpoints.documentId,
            documentGenerationCheckpoints.generationId,
          ],
          set: {
            durableSeq: input.durableSeq,
            stateBytes: Buffer.from(input.stateBytes),
            stateHash,
            createdAt,
          },
        });

      const [prunable] = await tx
        .select({
          count: sql<string>`count(*)::text`,
          bytes: sql<string>`coalesce(sum(octet_length(${collaborationUpdates.updateBytes})), 0)::text`,
        })
        .from(collaborationUpdates)
        .where(
          and(
            eq(collaborationUpdates.documentId, input.documentId),
            eq(collaborationUpdates.generationId, input.generationId),
            lte(collaborationUpdates.durableSeq, input.durableSeq),
            isNotNull(collaborationUpdates.updateBytes),
          ),
        );
      await tx
        .update(collaborationUpdates)
        .set({ updateBytes: null })
        .where(
          and(
            eq(collaborationUpdates.documentId, input.documentId),
            eq(collaborationUpdates.generationId, input.generationId),
            lte(collaborationUpdates.durableSeq, input.durableSeq),
            isNotNull(collaborationUpdates.updateBytes),
          ),
        );
      return {
        status: "compacted",
        prunedUpdates: Number(prunable?.count ?? 0),
        prunedBytes: Number(prunable?.bytes ?? 0),
        versionSnapshots: input.versionCheckpoints.length,
      };
    });
  }

  async loadUpdates(
    documentId: string,
    generationId: string,
    maxDurableSeq?: number,
  ): Promise<PersistedUpdate[]> {
    const rows = await this.db
      .select({
        updateHash: collaborationUpdates.updateHash,
        updateBytes: collaborationUpdates.updateBytes,
        durableSeq: collaborationUpdates.durableSeq,
      })
      .from(collaborationUpdates)
      .where(
        and(
          eq(collaborationUpdates.documentId, documentId),
          eq(collaborationUpdates.generationId, generationId),
          ...(maxDurableSeq === undefined
            ? []
            : [lte(collaborationUpdates.durableSeq, maxDurableSeq)]),
        ),
      )
      .orderBy(asc(collaborationUpdates.durableSeq));
    if (rows.some((row) => row.updateBytes === null)) {
      throw new Error("Compacted Yjs history must be replayed with replayYjsState");
    }
    return rows.map((row) => ({
      updateHash: row.updateHash,
      durableSeq: row.durableSeq,
      updateBytes: new Uint8Array(row.updateBytes as Buffer),
    }));
  }

  async findUpdateReceipt(
    documentId: string,
    generationId: string,
    updateHash: string,
  ): Promise<{ durableSeq: number } | null> {
    const [row] = await this.db
      .select({ durableSeq: collaborationUpdates.durableSeq })
      .from(collaborationUpdates)
      .where(
        and(
          eq(collaborationUpdates.documentId, documentId),
          eq(collaborationUpdates.generationId, generationId),
          or(
            eq(collaborationUpdates.updateHash, updateHash),
            eq(collaborationUpdates.sourceUpdateHash, updateHash),
          ),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
