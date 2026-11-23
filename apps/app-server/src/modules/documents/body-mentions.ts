import { and, eq, inArray, sql } from "drizzle-orm";
import { collectDocumentMentions, type DocumentContent } from "@zhishu/document-contracts";
import type { Database } from "../../../database/index.js";
import { documents, identityProfiles } from "../../../database/schema/index.js";
import { DomainError } from "../../shared/domain-error.js";
import { insertNotifications } from "../notifications/index.js";
import { documentActionSql } from "../authorization/permissions.js";

export async function recordBodyMentionNotifications(
  db: Pick<Database, "execute" | "select" | "insert">,
  input: {
    tenantId: string;
    documentId: string;
    workspaceId: string;
    generationId: string;
    previousSeq: number;
    durableSeq: number;
    actorId: string;
    content: DocumentContent;
  },
) {
  const current = collectDocumentMentions(input.content);
  if (!current.length) return;
  // Projection can lag behind a durable update. Read the exact prior revision from
  // its outbox payload or published snapshot in one statement, before superseding it.
  const previous =
    input.previousSeq === 0
      ? { rows: [{ content: { type: "doc", content: [] } as DocumentContent }] }
      : await db.execute<{ content: DocumentContent }>(sql`
    select snapshot_content as content from document_outbox where tenant_id = ${input.tenantId}
      and document_id = ${input.documentId} and generation_id = ${input.generationId}
      and durable_seq = ${input.previousSeq} and snapshot_content is not null
    union all select content from document_projection_snapshots where tenant_id = ${input.tenantId}
      and document_id = ${input.documentId} and generation_id = ${input.generationId} and durable_seq = ${input.previousSeq}
    limit 1
  `);
  if (!previous.rows[0])
    throw new DomainError("CONFLICT", "正文保存基线暂不可用，请稍后重试；本机草稿已保留。");
  const known = new Set(
    collectDocumentMentions(previous.rows[0].content).map((m) =>
      JSON.stringify([m.blockId, m.identityId]),
    ),
  );
  const recipients = [
    ...new Set(
      current
        .filter(
          (m) =>
            !known.has(JSON.stringify([m.blockId, m.identityId])) && m.identityId !== input.actorId,
        )
        .map((m) => m.identityId),
    ),
  ];
  if (!recipients.length) return;
  if (recipients.length > 100)
    throw new DomainError("VALIDATION_ERROR", "单次修改最多新增 100 位被提及成员");
  const visible = await db
    .select({ identityId: identityProfiles.identityId })
    .from(identityProfiles)
    .where(
      and(
        eq(identityProfiles.tenantId, input.tenantId),
        inArray(identityProfiles.identityId, recipients),
        sql`exists (select 1 from ${documents} where ${documents.id} = ${input.documentId} and ${documentActionSql({ tenantId: input.tenantId, identityId: identityProfiles.identityId }, "read")})`,
      ),
    );
  // Imported or retained mentions may reference absent or revoked members. Keep
  // the document intact; never notify them or grant access implicitly.
  await insertNotifications(
    db,
    visible.map((member) => ({
      tenantId: input.tenantId,
      recipientId: member.identityId,
      actorId: input.actorId,
      type: "mention",
      eventKey: `body-mention:${input.documentId}:${input.generationId}:${input.durableSeq}`,
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      message: "有人在文档正文中提及了你",
    })),
  );
}
