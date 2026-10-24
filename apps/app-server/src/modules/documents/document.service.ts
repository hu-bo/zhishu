import { createHash, randomUUID } from "node:crypto";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  createEditorSchema,
  normalizeTiptapDocumentJSON,
  validateContentForEditor,
} from "@zhishu/editor-core/schema";
import { DomainError } from "../../shared/domain-error.js";
import {
  checkDocumentCompatibility,
  cloneContentWithFreshBlockIds,
  repairDuplicateBlockIds,
  type DocumentContent,
  type ContentMigrationExecutor,
  type ContentMigrationReport,
  type ContentMigrationStepSnapshot,
  type ContentIssue,
  type ContentValidationResult,
} from "@zhishu/document-contracts";
import type { Principal } from "../identity/identity.types.js";
import { createSessionTicket } from "../collaboration/session-ticket.js";
import type {
  ActiveDocument,
  DocumentIdempotency,
  DocumentListItem,
  DocumentListView,
  DocumentRepository,
  DocumentVersion,
} from "./document.repository.js";
import type { DocumentPermissionAction } from "./document.permissions.js";
import type {
  CopyDocumentInput,
  DocumentTag,
  CollaborationSessionInput,
  CreateDocumentInput,
  CreateDocumentVersionInput,
  RestoreDocumentVersionInput,
  ImportDocumentInput,
} from "./document.schema.js";
import {
  emptyStructureState,
  projectContentUpdateToStructure,
  readStoredStructureState,
  sameDocumentContent,
  writeStoredStructureState,
} from "../collaboration/structure-operations.js";

export type CollaborationOptions = {
  tokenSecret: string;
  sessionTtlSeconds: number;
  providerUrl: string;
};

export type CollaborationSessionRevoker = {
  revokeDocumentSessions(documentId: string, generationId: string): void;
};

const collaborationPresenceColors = [
  "#2563EB",
  "#7C3AED",
  "#BE123C",
  "#0F766E",
  "#B45309",
  "#4D7C0F",
] as const;

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function migrationPersistence(stepSnapshots: readonly ContentMigrationStepSnapshot[]) {
  return stepSnapshots.length > 0 ? { migrationId: randomUUID(), stepSnapshots } : undefined;
}

function collaborationPresenceColor(identityId: string): string {
  const digest = createHash("sha256").update(identityId).digest();
  return collaborationPresenceColors[digest[0]! % collaborationPresenceColors.length]!;
}

export type DocumentMigrationOptions = {
  targetSchemaVersion: number;
  supportedSchemaVersions: readonly number[];
  execute: ContentMigrationExecutor;
  validateSource(content: unknown, schemaVersion: number): ContentValidationResult;
};

export type DuplicateBlockIdRepairResult =
  | { status: "clean" }
  | { status: "repairable"; duplicateCount: number }
  | {
      status: "repaired";
      duplicateCount: number;
      previousGenerationId: string;
      generationId: string;
    }
  | { status: "conflict" };

function presentDocument(document: ActiveDocument, identityId: string) {
  return {
    id: document.id,
    tenantId: document.tenantId,
    title: document.title,
    workspaceId: document.workspaceId ?? "ws_default",
    catalogId: document.catalogId ?? "",
    position: document.position ?? 0,
    icon: document.icon ?? null,
    tags: document.tags ?? [],
    createdBy: document.createdBy,
    generationId: document.generationId,
    schemaVersion: document.schemaVersion,
    extensions: document.extensions,
    durableSeq: document.durableSeq,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    metadataRevision: document.metadataRevision,
    canManage: document.createdBy === identityId,
  };
}

function presentListItem(document: DocumentListItem, identityId: string) {
  return {
    ...presentDocument(document, identityId),
    isFavorite: document.isFavorite,
    canManage: document.createdBy === identityId,
    deletedAt: document.deletedAt?.toISOString() ?? null,
    workspaceName: document.workspaceName,
    excerpt: document.excerpt,
  };
}

function presentVersion(version: DocumentVersion) {
  return {
    id: version.id,
    documentId: version.documentId,
    generationId: version.generationId,
    name: version.name,
    kind: version.kind,
    durableSeq: version.durableSeq,
    createdBy: version.createdBy,
    createdAt: version.createdAt.toISOString(),
  };
}

type ImportReportIssue = {
  code: string;
  path: string;
  message: string;
  recoverable: boolean;
};

function summarizePortableContent(content: unknown): {
  blockCount: number;
  assetCount: number;
  assetPaths: string[];
} {
  let blockCount = 0;
  let assetCount = 0;
  const assetPaths: string[] = [];
  const pending: Array<{ value: unknown; path: string }> = [{ value: content, path: "$" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current.value !== "object" || current.value === null) continue;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], path: `${current.path}/${index}` });
      }
      continue;
    }
    const node = current.value as { type?: unknown; attrs?: unknown; content?: unknown };
    if (
      typeof node.attrs === "object" &&
      node.attrs !== null &&
      !Array.isArray(node.attrs) &&
      typeof (node.attrs as { blockId?: unknown }).blockId === "string"
    ) {
      blockCount += 1;
    }
    if (node.type === "image" || node.type === "pdfAttachment") {
      assetCount += 1;
      assetPaths.push(`${current.path}/attrs`);
    }
    if (Array.isArray(node.content)) {
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        pending.push({ value: node.content[index], path: `${current.path}/content/${index}` });
      }
    }
  }
  return { blockCount, assetCount, assetPaths };
}

// Kept exported only for the one-time standard→collaborative migration script.
export function collectAssetReferences(
  content: DocumentContent,
): Array<{ assetId: string; blockId: string; mediaType: string }> {
  const references: Array<{ assetId: string; blockId: string; mediaType: string }> = [];
  const pending: unknown[] = [...content.content];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as {
      type?: unknown;
      attrs?: { assetId?: unknown; blockId?: unknown; mediaType?: unknown };
      content?: unknown;
    };
    if (
      (node.type === "image" || node.type === "pdfAttachment") &&
      typeof node.attrs?.assetId === "string" &&
      typeof node.attrs.blockId === "string" &&
      typeof node.attrs.mediaType === "string"
    ) {
      references.push({
        assetId: node.attrs.assetId,
        blockId: node.attrs.blockId,
        mediaType: node.attrs.mediaType,
      });
    }
    if (Array.isArray(node.content)) pending.push(...node.content);
  }
  return references;
}

// Kept exported only for the one-time standard→collaborative migration script.
export function createCollaborationStateFromContent(content: DocumentContent): Uint8Array {
  const doc = prosemirrorJSONToYDoc(createEditorSchema(), content, "content");
  const projectedStructure = projectContentUpdateToStructure(
    emptyStructureState(),
    { type: "doc", content: [] },
    content,
  );
  if (!projectedStructure.success) {
    doc.destroy();
    throw new DomainError("CONFLICT", "The version structure cannot be restored safely");
  }
  try {
    writeStoredStructureState(doc, projectedStructure.state, "version-snapshot-restore");
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function pushImportIssue(issues: ImportReportIssue[], issue: ImportReportIssue): void {
  if (issues.length < 100) {
    issues.push(issue);
  } else if (issues.length === 100) {
    issues.push({
      code: "report-truncated",
      path: "$",
      message: "Additional import issues were omitted from this report.",
      recoverable: false,
    });
  }
}

function asImportIssue(issue: ContentIssue): ImportReportIssue {
  return {
    code: issue.code,
    path: issue.path,
    message: issue.message,
    recoverable: issue.recoverable,
  };
}

export class DocumentService {
  constructor(
    private readonly repository: DocumentRepository,
    private readonly collaboration: CollaborationOptions,
    private readonly sessionRevoker: CollaborationSessionRevoker,
    private readonly migration: DocumentMigrationOptions,
    private readonly maxDocumentsPerTenant: number,
  ) {}

  private async replayDocumentYDoc(
    documentId: string,
    generationId: string,
    durableSeq: number,
    origin: string,
    failureMessage: string,
    versionId?: string,
  ): Promise<Y.Doc> {
    const yDoc = new Y.Doc();
    try {
      await this.repository.replayYjsState(
        {
          documentId,
          generationId,
          targetSeq: durableSeq,
          ...(versionId ? { versionId } : {}),
        },
        (updateBytes) => Y.applyUpdate(yDoc, updateBytes, origin),
      );
      return yDoc;
    } catch {
      yDoc.destroy();
      throw new DomainError("CONFLICT", failureMessage);
    }
  }

  async create(
    principal: Principal,
    input: CreateDocumentInput,
    requestId?: string,
    idempotencyKey?: string,
  ) {
    const idempotency: DocumentIdempotency | undefined = idempotencyKey
      ? {
          operationId: "documents.create",
          key: idempotencyKey,
          requestHash: createHash("sha256").update(stableJsonStringify(input)).digest("hex"),
        }
      : undefined;
    const document = await this.repository.create(
      principal.tenantId,
      principal.identityId,
      input.title,
      { schemaVersion: this.migration.targetSchemaVersion, extensions: [] },
      requestId,
      this.maxDocumentsPerTenant,
      undefined,
      idempotency,
      undefined,
      undefined,
      { workspaceId: input.workspaceId, catalogId: input.catalogId },
    );
    await this.repository.markRecent(document, principal.identityId);
    return presentDocument(document, principal.identityId);
  }

  async copyTemplate(
    principal: Principal,
    templateId: string,
    input: CopyDocumentInput,
    requestId?: string,
    idempotencyKey?: string,
  ) {
    const idempotency: DocumentIdempotency | undefined = idempotencyKey
      ? {
          operationId: "documents.copy",
          key: idempotencyKey,
          requestHash: createHash("sha256")
            .update(stableJsonStringify({ templateId, title: input.title }))
            .digest("hex"),
        }
      : undefined;
    if (idempotency) {
      const replay = await this.repository.findDocumentIdempotencyReplay({
        tenantId: principal.tenantId,
        subjectId: principal.identityId,
        idempotency,
      });
      if (replay) return presentDocument(replay, principal.identityId);
    }

    const template = await this.repository.findActiveForAction(
      templateId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!template) throw new DomainError("NOT_FOUND", "An accessible template was not found");

    const sourceDoc = await this.replayDocumentYDoc(
      template.id,
      template.generationId,
      template.durableSeq,
      "template-copy-source",
      "The template update history is incomplete",
    );
    try {
      const sourceContent = (() => {
        const projected = yDocToProsemirrorJSON(sourceDoc, "content");
        return normalizeTiptapDocumentJSON(
          Array.isArray(projected.content) || projected.content !== undefined
            ? projected
            : { ...projected, content: [] },
        );
      })();
      const validatedSource = this.migration.validateSource(sourceContent, template.schemaVersion);
      if (!validatedSource.success) {
        throw new DomainError("CONFLICT", "The template content cannot be copied safely");
      }
      const pendingBlocks: unknown[] = [...validatedSource.data.content];
      while (pendingBlocks.length > 0) {
        const block = pendingBlocks.pop();
        if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
        const node = block as { type?: unknown; content?: unknown };
        if (node.type === "image" || node.type === "pdfAttachment") {
          throw new DomainError(
            "CONFLICT",
            "Templates containing attachments cannot be copied until document asset cloning is available",
          );
        }
        if (Array.isArray(node.content)) pendingBlocks.push(...node.content);
      }

      const migrated = this.migration.execute(
        validatedSource.data,
        template.schemaVersion,
        this.migration.targetSchemaVersion,
      );
      if (!migrated.success || migrated.report.status === "failed") {
        throw new DomainError("CONFLICT", "The template schema cannot be copied safely");
      }
      const migrationArchive = migrationPersistence(migrated.stepSnapshots);
      const sourceStructure = readStoredStructureState(sourceDoc);
      if (!sourceStructure || !sameDocumentContent(sourceStructure.content, validatedSource.data)) {
        throw new DomainError("CONFLICT", "The template content projection is inconsistent");
      }

      const content = cloneContentWithFreshBlockIds(migrated.content);
      let initialUpdate:
        { updateHash: string; updateBytes: Uint8Array; content: DocumentContent } | undefined;
      if (content.content.length > 0) {
        const editorValidation = validateContentForEditor(content, createEditorSchema());
        if (!editorValidation.success) {
          throw new DomainError("CONFLICT", "The template content uses unsupported editor nodes");
        }
        const targetDoc = prosemirrorJSONToYDoc(createEditorSchema(), content, "content");
        try {
          const projectedStructure = projectContentUpdateToStructure(
            emptyStructureState(),
            { type: "doc", content: [] },
            content,
          );
          if (!projectedStructure.success) {
            throw new DomainError("CONFLICT", "The template structure cannot be copied safely");
          }
          writeStoredStructureState(targetDoc, projectedStructure.state);
          const updateBytes = Y.encodeStateAsUpdate(targetDoc);
          initialUpdate = {
            updateHash: createHash("sha256").update(updateBytes).digest("hex"),
            updateBytes,
            content,
          };
        } finally {
          targetDoc.destroy();
        }
      }

      const result = await this.repository.copyTemplate({
        tenantId: principal.tenantId,
        identityId: principal.identityId,
        templateId,
        expectedGenerationId: template.generationId,
        expectedDurableSeq: template.durableSeq,
        title: input.title,
        schemaVersion: this.migration.targetSchemaVersion,
        extensions: template.extensions,
        requestId,
        maxDocumentsPerTenant: this.maxDocumentsPerTenant,
        ...(idempotency ? { idempotency } : {}),
        ...(initialUpdate ? { initialUpdate } : {}),
        ...(migrationArchive ? { migrationPersistence: migrationArchive } : {}),
      });
      if (result.status === "not-found") {
        throw new DomainError("NOT_FOUND", "An accessible template was not found");
      }
      if (result.status === "conflict") {
        throw new DomainError("CONFLICT", "The template changed while it was being copied");
      }
      if (result.status === "quota-exceeded") {
        throw new DomainError("RESOURCE_LIMIT", "The tenant document limit has been reached", {
          limit: this.maxDocumentsPerTenant,
        });
      }
      if (result.status === "replayed") {
        return presentDocument(result.document, principal.identityId);
      }
      await this.repository.markRecent(result.document, principal.identityId);
      return presentDocument(result.document, principal.identityId);
    } finally {
      sourceDoc?.destroy();
    }
  }

  async list(
    principal: Principal,
    input: {
      view: DocumentListView;
      q?: string;
      workspaceId?: string;
      sort: "recent" | "updated" | "created" | "title";
      direction: "asc" | "desc";
      limit: number;
      offset: number;
    },
  ) {
    const result = await this.repository.list({
      tenantId: principal.tenantId,
      identityId: principal.identityId,
      ...input,
      query: input.q,
    });
    return {
      ...result,
      items: result.items.map((item) => presentListItem(item, principal.identityId)),
    };
  }

  async updateTitle(
    principal: Principal,
    documentId: string,
    input: { title?: string; icon?: string | null; tags?: DocumentTag[]; metadataRevision: number },
    requestId?: string,
    idempotencyKey?: string,
  ) {
    const idempotency: DocumentIdempotency | undefined = idempotencyKey
      ? {
          operationId: "documents.metadata.update",
          key: idempotencyKey,
          requestHash: createHash("sha256")
            .update(stableJsonStringify({ documentId, input }))
            .digest("hex"),
        }
      : undefined;
    const result = await this.repository.updateTitle({
      tenantId: principal.tenantId,
      documentId,
      identityId: principal.identityId,
      title: input.title,
      icon: input.icon,
      tags: input.tags,
      expectedRevision: input.metadataRevision,
      requestId,
      ...(idempotency ? { idempotency } : {}),
    });
    if (result.status === "not-found") throw new DomainError("NOT_FOUND", "Document not found");
    if (result.status === "conflict")
      throw new DomainError("CONFLICT", "Document metadata changed");
    return presentDocument(result.document, principal.identityId);
  }

  async setFavorite(principal: Principal, documentId: string, favorite: boolean): Promise<void> {
    const found = await this.repository.setFavorite(
      principal.tenantId,
      documentId,
      principal.identityId,
      favorite,
    );
    if (!found) throw new DomainError("NOT_FOUND", "Document not found");
  }

  async lifecycle(
    principal: Principal,
    documentId: string,
    operation: "archive" | "trash" | "restore" | "purge",
    requestId?: string,
    idempotencyKey?: string,
  ): Promise<void> {
    const idempotency: DocumentIdempotency | undefined = idempotencyKey
      ? {
          operationId: "documents.lifecycle",
          key: idempotencyKey,
          requestHash: createHash("sha256")
            .update(stableJsonStringify({ documentId, operation }))
            .digest("hex"),
        }
      : undefined;
    const result = await this.repository.setLifecycle({
      tenantId: principal.tenantId,
      documentId,
      ownerId: principal.identityId,
      operation,
      requestId,
      ...(idempotency ? { idempotency } : {}),
    });
    if (result.status === "not-found" || result.status === "not-owner")
      throw new DomainError("NOT_FOUND", "Document not found");
    if (result.status === "conflict")
      throw new DomainError(
        "CONFLICT",
        `Document cannot ${operation} from ${result.currentStatus}`,
      );
    this.sessionRevoker.revokeDocumentSessions(documentId, result.generationId);
  }

  async get(principal: Principal, documentId: string) {
    const document = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!document) throw new DomainError("NOT_FOUND", "Document not found");
    await this.repository.markRecent(document, principal.identityId);
    return presentDocument(document, principal.identityId);
  }

  async getContent(principal: Principal, documentId: string) {
    const document = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!document) throw new DomainError("NOT_FOUND", "Document not found");
    const readOnly =
      (await this.repository.findActiveForAction(
        documentId,
        principal.tenantId,
        principal.identityId,
        "write",
      )) === null;
    const snapshot = await this.repository.findProjectionContentSnapshot(
      principal.tenantId,
      documentId,
      document.generationId,
    );
    if (!snapshot)
      throw new DomainError("CONFLICT", "The document content snapshot is unavailable");
    return {
      documentId,
      readOnly,
      schemaVersion: document.schemaVersion,
      extensions: document.extensions,
      generationId: document.generationId,
      durableSeq: snapshot.durableSeq,
      snapshotRevision: snapshot.snapshotRevision,
      content: snapshot.content,
    };
  }

  async exportJson(principal: Principal, documentId: string, requestId?: string) {
    const document = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "export",
    );
    if (!document) throw new DomainError("NOT_FOUND", "Document not found");

    const yDoc = await this.replayDocumentYDoc(
      document.id,
      document.generationId,
      document.durableSeq,
      "document-export-replay",
      "The document update history is incomplete",
    );
    try {
      const source = (() => {
        const projected = yDocToProsemirrorJSON(yDoc, "content");
        return normalizeTiptapDocumentJSON(
          Array.isArray(projected.content) || projected.content !== undefined
            ? projected
            : { ...projected, content: [] },
        );
      })();
      const validated = this.migration.validateSource(source, document.schemaVersion);
      if (
        !validated.success ||
        !validateContentForEditor(validated.data, createEditorSchema()).success
      ) {
        throw new DomainError("CONFLICT", "The document content cannot be exported safely");
      }
      const summary = summarizePortableContent(validated.data);
      const recorded = await this.repository.recordExport({
        tenantId: principal.tenantId,
        documentId: document.id,
        identityId: principal.identityId,
        generationId: document.generationId,
        durableSeq: document.durableSeq,
        schemaVersion: document.schemaVersion,
        blockCount: summary.blockCount,
        requestId,
      });
      if (recorded === "not-found" || recorded === "not-authorized") {
        throw new DomainError("NOT_FOUND", "Document not found");
      }
      if (recorded === "conflict") {
        throw new DomainError("CONFLICT", "The document changed while it was being exported");
      }
      return {
        format: "zhishu.document" as const,
        formatVersion: 1 as const,
        title: document.title,
        schemaVersion: document.schemaVersion,
        extensions: document.extensions,
        content: validated.data,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("CONFLICT", "The document content cannot be exported safely");
    } finally {
      yDoc.destroy();
    }
  }

  async importJson(
    principal: Principal,
    input: ImportDocumentInput,
    requestId?: string,
    idempotencyKey?: string,
  ) {
    const normalized = normalizeTiptapDocumentJSON(input.content);
    const summary = summarizePortableContent(normalized);
    const issues: ImportReportIssue[] = [];
    const compatibility = checkDocumentCompatibility(
      { schemaVersion: input.schemaVersion, extensions: input.extensions },
      { schemaVersions: this.migration.supportedSchemaVersions, extensions: {} },
    );
    for (const compatibilityIssue of compatibility.issues) {
      pushImportIssue(issues, {
        code: compatibilityIssue.code,
        path: compatibilityIssue.code === "unsupported-schema" ? "$/schemaVersion" : "$/extensions",
        message:
          compatibilityIssue.code === "unsupported-schema"
            ? `Schema version ${compatibilityIssue.name} is not supported for import.`
            : `Extension ${compatibilityIssue.name} is not supported by this server.`,
        recoverable: !compatibilityIssue.required,
      });
    }
    if (
      new Set(input.extensions.map((extension) => extension.name)).size !== input.extensions.length
    ) {
      pushImportIssue(issues, {
        code: "duplicate-extension",
        path: "$/extensions",
        message: "Each extension may only be declared once.",
        recoverable: false,
      });
    }

    const validation = this.migration.validateSource(normalized, input.schemaVersion);
    let contentToImport: DocumentContent | null = null;
    let migrationReport: ContentMigrationReport | undefined;
    let migrationArchive: ReturnType<typeof migrationPersistence>;
    if (!validation.success) {
      for (const issue of validation.issues) pushImportIssue(issues, asImportIssue(issue));
    } else {
      const migrated = this.migration.execute(
        validation.data,
        input.schemaVersion,
        this.migration.targetSchemaVersion,
      );
      if (!migrated.success) {
        pushImportIssue(issues, {
          code: "invalid-content",
          path: "$/schemaVersion",
          message: "The document content could not be migrated safely.",
          recoverable: false,
        });
      } else {
        migrationReport = migrated.report;
        migrationArchive = migrationPersistence(migrated.stepSnapshots);
        const editorValidation = validateContentForEditor(migrated.content, createEditorSchema());
        if (!editorValidation.success) {
          for (const issue of editorValidation.issues) {
            pushImportIssue(issues, { ...asImportIssue(issue), recoverable: false });
          }
        } else {
          contentToImport = editorValidation.content;
        }
      }
    }
    for (const path of summary.assetPaths) {
      pushImportIssue(issues, {
        code: "unsupported-asset",
        path,
        message: "Asset references cannot be transferred by this JSON import format.",
        recoverable: false,
      });
    }

    const report = {
      formatVersion: 1 as const,
      issues,
      blockCount: summary.blockCount,
      assetCount: summary.assetCount,
    };
    if (
      !validation.success ||
      contentToImport === null ||
      !compatibility.readable ||
      issues.some((issue) => !issue.recoverable)
    ) {
      return { status: "rejected" as const, report };
    }

    const targetDoc = prosemirrorJSONToYDoc(createEditorSchema(), contentToImport, "content");
    try {
      const projectedStructure = projectContentUpdateToStructure(
        emptyStructureState(),
        { type: "doc", content: [] },
        contentToImport,
      );
      if (!projectedStructure.success) {
        throw new DomainError("CONFLICT", "The imported document structure is invalid");
      }
      writeStoredStructureState(targetDoc, projectedStructure.state);
      const updateBytes = Y.encodeStateAsUpdate(targetDoc);
      const updateHash = createHash("sha256").update(updateBytes).digest("hex");
      const idempotency: DocumentIdempotency | undefined = idempotencyKey
        ? {
            operationId: "documents.import",
            key: idempotencyKey,
            requestHash: createHash("sha256")
              .update(
                stableJsonStringify({
                  title: input.title,
                  schemaVersion: input.schemaVersion,
                  extensions: input.extensions,
                  content: normalized,
                }),
              )
              .digest("hex"),
          }
        : undefined;
      const document = await this.repository.create(
        principal.tenantId,
        principal.identityId,
        input.title,
        { schemaVersion: this.migration.targetSchemaVersion, extensions: input.extensions },
        requestId,
        this.maxDocumentsPerTenant,
        { updateHash, updateBytes, content: contentToImport },
        idempotency,
        migrationReport,
        migrationArchive,
      );
      await this.repository.markRecent(document, principal.identityId);
      return {
        status: "completed" as const,
        document: presentDocument(document, principal.identityId),
        report,
      };
    } finally {
      targetDoc.destroy();
    }
  }

  async listVersions(principal: Principal, documentId: string) {
    const document = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!document) throw new DomainError("NOT_FOUND", "Document not found");
    return (await this.repository.listVersions(principal.tenantId, documentId)).map(presentVersion);
  }

  async getVersion(principal: Principal, documentId: string, versionId: string) {
    const document = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!document) throw new DomainError("NOT_FOUND", "Document not found");
    const version = await this.repository.findVersion(principal.tenantId, documentId, versionId);
    if (!version) throw new DomainError("NOT_FOUND", "Document version not found");
    return presentVersion(version);
  }

  async getVersionContent(principal: Principal, documentId: string, versionId: string) {
    const document = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!document) throw new DomainError("NOT_FOUND", "Document not found");
    const version = await this.repository.findVersion(principal.tenantId, documentId, versionId);
    if (!version) throw new DomainError("NOT_FOUND", "Document version not found");
    const schemaVersion = await this.repository.findGenerationSchemaVersion(
      documentId,
      version.generationId,
    );
    if (schemaVersion === null) {
      throw new DomainError("CONFLICT", "The document version content is unavailable");
    }

    const versionDoc = await this.replayDocumentYDoc(
      documentId,
      version.generationId,
      version.durableSeq,
      "version-preview-replay",
      "The document version update history is incomplete",
      version.id,
    );
    try {
      const projected = yDocToProsemirrorJSON(versionDoc, "content");
      const source = normalizeTiptapDocumentJSON(
        Array.isArray(projected.content) || projected.content !== undefined
          ? projected
          : { ...projected, content: [] },
      );
      const validated = this.migration.validateSource(source, schemaVersion);
      if (!validated.success) {
        throw new DomainError("CONFLICT", "The document version content cannot be read safely");
      }
      return {
        documentId,
        generationId: version.generationId,
        schemaVersion,
        durableSeq: version.durableSeq,
        content: validated.data,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("CONFLICT", "The document version content cannot be read safely");
    } finally {
      versionDoc.destroy();
    }
  }

  async createVersion(
    principal: Principal,
    documentId: string,
    input: CreateDocumentVersionInput,
    requestId?: string,
    idempotencyKey?: string,
  ) {
    const idempotency: DocumentIdempotency | undefined = idempotencyKey
      ? {
          operationId: "documents.version.create",
          key: idempotencyKey,
          requestHash: createHash("sha256")
            .update(stableJsonStringify({ documentId, input }))
            .digest("hex"),
        }
      : undefined;
    const result = await this.repository.createVersion({
      tenantId: principal.tenantId,
      documentId,
      identityId: principal.identityId,
      name: input.name,
      expectedGenerationId: input.expectedGenerationId,
      expectedDurableSeq: input.expectedDurableSeq,
      requestId,
      ...(idempotency ? { idempotency } : {}),
    });
    if (result.status === "not-found") throw new DomainError("NOT_FOUND", "Document not found");
    if (result.status !== "created" && result.status !== "replayed")
      throw new DomainError(
        "CONFLICT",
        "Document changed or a version with that name already exists",
      );
    return presentVersion(result.version);
  }

  async restoreVersion(
    principal: Principal,
    documentId: string,
    versionId: string,
    input: RestoreDocumentVersionInput,
    requestId?: string,
    idempotencyKey?: string,
  ) {
    const idempotency: DocumentIdempotency | undefined = idempotencyKey
      ? {
          operationId: "documents.version.restore",
          key: idempotencyKey,
          requestHash: createHash("sha256")
            .update(stableJsonStringify({ documentId, versionId, input }))
            .digest("hex"),
        }
      : undefined;
    const restoredContent = await this.getVersionContent(principal, documentId, versionId);
    const version = await this.repository.findVersion(principal.tenantId, documentId, versionId);
    if (!version) throw new DomainError("NOT_FOUND", "Document or version not found");
    const stateBytes = await this.createVersionStateBytes(documentId, version);
    const result = await this.repository.restoreVersion({
      tenantId: principal.tenantId,
      documentId,
      versionId,
      identityId: principal.identityId,
      expectedGenerationId: input.expectedGenerationId,
      expectedDurableSeq: input.expectedDurableSeq,
      requestId,
      content: restoredContent.content,
      stateBytes,
      ...(idempotency ? { idempotency } : {}),
    });
    if (result.status === "not-found")
      throw new DomainError("NOT_FOUND", "Document or version not found");
    if (result.status !== "restored" && result.status !== "restore-replayed")
      throw new DomainError("CONFLICT", "Document changed or version content is unavailable");
    if (result.status === "restored")
      this.sessionRevoker.revokeDocumentSessions(documentId, result.previousGenerationId);
    return presentDocument(result.document, principal.identityId);
  }

  private async createVersionStateBytes(
    documentId: string,
    version: DocumentVersion,
  ): Promise<Uint8Array> {
    const versionDoc = await this.replayDocumentYDoc(
      documentId,
      version.generationId,
      version.durableSeq,
      "version-restore-checkpoint",
      "The document version content is unavailable",
      version.id,
    );
    try {
      return Y.encodeStateAsUpdate(versionDoc);
    } finally {
      versionDoc.destroy();
    }
  }

  async listAcl(principal: Principal, documentId: string) {
    const entries = await this.repository.listAcl(
      principal.tenantId,
      documentId,
      principal.identityId,
    );
    if (!entries) throw new DomainError("NOT_FOUND", "Document not found");
    return entries;
  }

  async setAcl(
    principal: Principal,
    documentId: string,
    identityId: string,
    actions: readonly DocumentPermissionAction[],
    requestId?: string,
    idempotencyKey?: string,
  ) {
    const idempotency: DocumentIdempotency | undefined = idempotencyKey
      ? {
          operationId: "documents.acl.set",
          key: idempotencyKey,
          requestHash: createHash("sha256")
            .update(stableJsonStringify({ documentId, identityId, actions }))
            .digest("hex"),
        }
      : undefined;
    const result = await this.repository.setAcl(
      principal.tenantId,
      documentId,
      principal.identityId,
      identityId,
      actions,
      requestId,
      idempotency,
    );
    if (result.status === "not-found" || result.status === "not-owner")
      throw new DomainError("NOT_FOUND", "Document not found");
    if (result.status === "updated")
      this.sessionRevoker.revokeDocumentSessions(documentId, result.generationId);
    return { documentId, identityId, actions: result.actions };
  }

  async removeAcl(
    principal: Principal,
    documentId: string,
    identityId: string,
    requestId?: string,
    idempotencyKey?: string,
  ): Promise<void> {
    const idempotency: DocumentIdempotency | undefined = idempotencyKey
      ? {
          operationId: "documents.acl.remove",
          key: idempotencyKey,
          requestHash: createHash("sha256")
            .update(stableJsonStringify({ documentId, identityId }))
            .digest("hex"),
        }
      : undefined;
    const result = await this.repository.removeAcl(
      principal.tenantId,
      documentId,
      principal.identityId,
      identityId,
      requestId,
      idempotency,
    );
    if (result.status === "not-found" || result.status === "not-owner")
      throw new DomainError("NOT_FOUND", "Document not found");
    if (result.status === "updated")
      this.sessionRevoker.revokeDocumentSessions(documentId, result.generationId);
  }

  async repairDuplicateBlockIds(
    principal: Principal,
    documentId: string,
    apply: boolean,
  ): Promise<DuplicateBlockIdRepairResult> {
    const source = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "write",
    );
    if (!source) return { status: "conflict" };

    const sourceDoc = await this.replayDocumentYDoc(
      source.id,
      source.generationId,
      source.durableSeq,
      "block-id-repair-source",
      "The document update history is incomplete",
    ).catch(() => null);
    if (!sourceDoc) return { status: "conflict" };
    try {
      const projected = yDocToProsemirrorJSON(sourceDoc, "content");
      const content = normalizeTiptapDocumentJSON(
        Array.isArray(projected.content) || projected.content !== undefined
          ? projected
          : { ...projected, content: [] },
      );
      const validated = this.migration.validateSource(content, source.schemaVersion);
      if (validated.success) return { status: "clean" };
      const duplicateCount = validated.issues.filter(
        (item) => item.code === "duplicate-block-id",
      ).length;
      if (duplicateCount === 0 || duplicateCount !== validated.issues.length) {
        return { status: "conflict" };
      }

      let repaired: ReturnType<typeof repairDuplicateBlockIds>;
      try {
        repaired = repairDuplicateBlockIds(content);
      } catch {
        return { status: "conflict" };
      }
      if (repaired.repairedCount !== duplicateCount) return { status: "conflict" };

      const migrated = this.migration.execute(
        repaired.content,
        source.schemaVersion,
        this.migration.targetSchemaVersion,
      );
      if (!migrated.success || migrated.report.status === "failed") {
        return { status: "conflict" };
      }
      const migrationArchive = migrationPersistence(migrated.stepSnapshots);
      const editorValidation = validateContentForEditor(migrated.content, createEditorSchema());
      if (!editorValidation.success) return { status: "conflict" };
      if (!apply) return { status: "repairable", duplicateCount };

      const targetDoc = prosemirrorJSONToYDoc(createEditorSchema(), migrated.content, "content");
      try {
        const projectedStructure = projectContentUpdateToStructure(
          emptyStructureState(),
          { type: "doc", content: [] },
          migrated.content,
        );
        if (!projectedStructure.success) return { status: "conflict" };
        writeStoredStructureState(targetDoc, projectedStructure.state);
        const updateBytes = Y.encodeStateAsUpdate(targetDoc);
        const updateHash = createHash("sha256").update(updateBytes).digest("hex");
        const result = await this.repository.switchActiveGeneration({
          tenantId: principal.tenantId,
          documentId: source.id,
          identityId: principal.identityId,
          expectedGenerationId: source.generationId,
          expectedSchemaVersion: source.schemaVersion,
          expectedDurableSeq: source.durableSeq,
          targetSchemaVersion: this.migration.targetSchemaVersion,
          extensions: source.extensions,
          updateHash,
          updateBytes,
          content: migrated.content,
          migrationReport: migrated.report,
          ...(migrationArchive ? { migrationPersistence: migrationArchive } : {}),
        });
        if (result.status === "conflict" || result.status === "not-found") {
          return { status: "conflict" };
        }
        if (result.status !== "repaired") return { status: "conflict" };
        this.sessionRevoker.revokeDocumentSessions(source.id, result.previousGenerationId);
        return {
          status: "repaired",
          duplicateCount,
          previousGenerationId: result.previousGenerationId,
          generationId: result.document.generationId,
        };
      } finally {
        targetDoc.destroy();
      }
    } catch {
      return { status: "conflict" };
    } finally {
      sourceDoc.destroy();
    }
  }

  async createCollaborationSession(
    principal: Principal,
    documentId: string,
    client: CollaborationSessionInput,
  ) {
    if (
      new Set(client.extensions.map((extension) => extension.name)).size !==
      client.extensions.length
    )
      throw new DomainError("VALIDATION_ERROR", "Each extension name may only be declared once");
    let document = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!document) throw new DomainError("NOT_FOUND", "Document not found");
    const writableDocument = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "write",
    );
    // Every document is collaborative. The one-time standard→collaborative
    // migration lives in src/scripts/migrate-standard-to-collaborative.ts.
    if (writableDocument && document.schemaVersion < this.migration.targetSchemaVersion) {
      document = await this.migrateActiveGeneration(principal, document);
    }
    const canWriteCurrentGeneration =
      (await this.repository.findActiveForAction(
        documentId,
        principal.tenantId,
        principal.identityId,
        "write",
      )) !== null;
    const compatibility = checkDocumentCompatibility(
      { schemaVersion: document.schemaVersion, extensions: document.extensions },
      {
        schemaVersions: [client.schemaVersion],
        extensions: Object.fromEntries(
          client.extensions.map((extension) => [extension.name, [extension.version]]),
        ),
      },
    );
    if (!compatibility.readable)
      throw new DomainError("CONFLICT", "The client cannot safely read this document schema");
    const writable = compatibility.writable && canWriteCurrentGeneration;

    const session = createSessionTicket(
      {
        tenantId: document.tenantId,
        documentId: document.id,
        generationId: document.generationId,
        schemaVersion: document.schemaVersion,
        extensions: document.extensions,
        subject: principal.identityId,
        displayName: principal.displayName.trim().slice(0, 80) || principal.identityId.slice(0, 80),
        presenceColor: collaborationPresenceColor(principal.identityId),
        readOnly: !writable,
      },
      this.collaboration.tokenSecret,
      this.collaboration.sessionTtlSeconds,
    );
    return {
      documentId: document.id,
      generationId: document.generationId,
      schemaVersion: document.schemaVersion,
      extensions: document.extensions,
      compatibility: { readable: true as const, writable },
      durableSeq: document.durableSeq,
      documentName: `${document.id}:${document.generationId}`,
      providerUrl: this.collaboration.providerUrl,
      token: session.token,
      expiresAt: new Date(session.claims.expiresAt * 1000).toISOString(),
      readOnly: session.claims.readOnly,
      capabilities: { durableAck: true as const, readOnly: true as const },
    };
  }

  private async migrateActiveGeneration(
    principal: Principal,
    source: ActiveDocument,
  ): Promise<ActiveDocument> {
    const sourceDoc = await this.replayDocumentYDoc(
      source.id,
      source.generationId,
      source.durableSeq,
      "schema-migration-source",
      "The document update history is incomplete",
    );
    try {
      const projected = yDocToProsemirrorJSON(sourceDoc, "content");
      const sourceContent =
        Array.isArray(projected.content) || projected.content !== undefined
          ? projected
          : { ...projected, content: [] };
      const validatedSource = this.migration.validateSource(sourceContent, source.schemaVersion);
      if (!validatedSource.success) {
        throw new DomainError("CONFLICT", "The document content cannot be migrated safely");
      }

      const migrated = this.migration.execute(
        validatedSource.data,
        source.schemaVersion,
        this.migration.targetSchemaVersion,
      );
      if (!migrated.success || migrated.report.status !== "migrated") {
        throw new DomainError("CONFLICT", "No safe document migration is available");
      }
      const migrationArchive = migrationPersistence(migrated.stepSnapshots);

      let updateBytes: Uint8Array;
      const targetDoc = prosemirrorJSONToYDoc(createEditorSchema(), migrated.content, "content");
      try {
        updateBytes = Y.encodeStateAsUpdate(targetDoc);
      } finally {
        targetDoc.destroy();
      }
      const updateHash = createHash("sha256").update(updateBytes).digest("hex");
      const result = await this.repository.switchActiveGeneration({
        tenantId: principal.tenantId,
        documentId: source.id,
        identityId: principal.identityId,
        expectedGenerationId: source.generationId,
        expectedSchemaVersion: source.schemaVersion,
        expectedDurableSeq: source.durableSeq,
        targetSchemaVersion: this.migration.targetSchemaVersion,
        extensions: source.extensions,
        updateHash,
        updateBytes,
        content: migrated.content,
        migrationReport: migrated.report,
        ...(migrationArchive ? { migrationPersistence: migrationArchive } : {}),
      });
      if (result.status === "not-found") throw new DomainError("NOT_FOUND", "Document not found");
      if (result.status !== "migrated") {
        throw new DomainError("CONFLICT", "The document changed while its schema was migrating");
      }
      this.sessionRevoker.revokeDocumentSessions(source.id, result.previousGenerationId);
      return result.document;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("CONFLICT", "The document content cannot be migrated safely");
    } finally {
      sourceDoc.destroy();
    }
  }
}
