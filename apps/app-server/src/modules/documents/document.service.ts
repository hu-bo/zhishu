import { createHash } from "node:crypto";
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
  type ContentValidationResult,
} from "@zhishu/document-contracts";
import type { Principal } from "../identity/identity.types.js";
import { createSessionTicket } from "../collaboration/session-ticket.js";
import type {
  ActiveDocument,
  DocumentListView,
  DocumentRepository,
  DocumentVersion,
} from "./document.repository.js";
import type { DocumentPermissionAction } from "./document.permissions.js";
import type {
  CollaborationSessionInput,
  CreateDocumentInput,
  CreateDocumentVersionInput,
  RestoreDocumentVersionInput,
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

export type DocumentMigrationOptions = {
  targetSchemaVersion: number;
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

function presentDocument(document: ActiveDocument) {
  return {
    id: document.id,
    tenantId: document.tenantId,
    title: document.title,
    generationId: document.generationId,
    schemaVersion: document.schemaVersion,
    extensions: document.extensions,
    durableSeq: document.durableSeq,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    metadataRevision: document.metadataRevision,
  };
}

function presentListItem(
  document: ActiveDocument & { isFavorite: boolean; deletedAt: Date | null },
  identityId: string,
) {
  return {
    ...presentDocument(document),
    isFavorite: document.isFavorite,
    canManage: document.createdBy === identityId,
    deletedAt: document.deletedAt?.toISOString() ?? null,
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

export class DocumentService {
  constructor(
    private readonly repository: DocumentRepository,
    private readonly collaboration: CollaborationOptions,
    private readonly sessionRevoker: CollaborationSessionRevoker,
    private readonly migration: DocumentMigrationOptions,
    private readonly maxDocumentsPerTenant: number,
  ) {}

  async create(principal: Principal, input: CreateDocumentInput, requestId?: string) {
    const document = await this.repository.create(
      principal.tenantId,
      principal.identityId,
      input.title,
      undefined,
      requestId,
      this.maxDocumentsPerTenant,
    );
    await this.repository.markRecent(document, principal.identityId);
    return presentDocument(document);
  }

  async copyTemplate(
    principal: Principal,
    templateId: string,
    input: CreateDocumentInput,
    requestId?: string,
  ) {
    const template = await this.repository.findActiveForAction(
      templateId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!template) throw new DomainError("NOT_FOUND", "An accessible template was not found");

    const updates = await this.repository.loadUpdates(
      template.id,
      template.generationId,
      template.durableSeq,
    );
    if (updates.length !== template.durableSeq) {
      throw new DomainError("CONFLICT", "The template update history is incomplete");
    }

    const sourceDoc = new Y.Doc();
    let expectedSeq = 1;
    try {
      for (const update of updates) {
        if (update.durableSeq !== expectedSeq) {
          throw new DomainError("CONFLICT", "The template update history is incomplete");
        }
        Y.applyUpdate(sourceDoc, update.updateBytes, "template-copy-source");
        expectedSeq += 1;
      }
      if (expectedSeq - 1 !== template.durableSeq) {
        throw new DomainError("CONFLICT", "The template update history is incomplete");
      }

      const projected = yDocToProsemirrorJSON(sourceDoc, "content");
      const sourceContent = normalizeTiptapDocumentJSON(
        Array.isArray(projected.content) || projected.content !== undefined
          ? projected
          : { ...projected, content: [] },
      );
      const validatedSource = this.migration.validateSource(sourceContent, template.schemaVersion);
      if (!validatedSource.success) {
        throw new DomainError("CONFLICT", "The template content cannot be copied safely");
      }
      const pendingBlocks: unknown[] = [...validatedSource.data.content];
      while (pendingBlocks.length > 0) {
        const block = pendingBlocks.pop();
        if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
        const node = block as { type?: unknown; content?: unknown };
        if (node.type === "image") {
          throw new DomainError(
            "CONFLICT",
            "Templates containing images cannot be copied until document asset cloning is available",
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
        ...(initialUpdate ? { initialUpdate } : {}),
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
      await this.repository.markRecent(result.document, principal.identityId);
      return presentDocument(result.document);
    } finally {
      sourceDoc.destroy();
    }
  }

  async list(
    principal: Principal,
    input: {
      view: DocumentListView;
      q?: string;
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
    });
    return {
      ...result,
      items: result.items.map((item) => presentListItem(item, principal.identityId)),
    };
  }

  async updateTitle(
    principal: Principal,
    documentId: string,
    input: { title: string; metadataRevision: number },
    requestId?: string,
  ) {
    const result = await this.repository.updateTitle({
      tenantId: principal.tenantId,
      documentId,
      identityId: principal.identityId,
      title: input.title,
      expectedRevision: input.metadataRevision,
      requestId,
    });
    if (result.status === "not-found") throw new DomainError("NOT_FOUND", "Document not found");
    if (result.status === "conflict")
      throw new DomainError("CONFLICT", "Document metadata changed");
    const updated = await this.repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!updated) throw new DomainError("NOT_FOUND", "Document not found");
    return presentDocument(updated);
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
  ): Promise<void> {
    const result = await this.repository.setLifecycle({
      tenantId: principal.tenantId,
      documentId,
      ownerId: principal.identityId,
      operation,
      requestId,
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
    return presentDocument(document);
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

    const updates = await this.repository.loadUpdates(
      documentId,
      version.generationId,
      version.durableSeq,
    );
    if (updates.length !== version.durableSeq) {
      throw new DomainError("CONFLICT", "The document version update history is incomplete");
    }

    const versionDoc = new Y.Doc();
    let expectedSeq = 1;
    try {
      for (const update of updates) {
        if (update.durableSeq !== expectedSeq) {
          throw new DomainError("CONFLICT", "The document version update history is incomplete");
        }
        Y.applyUpdate(versionDoc, update.updateBytes, "version-preview-replay");
        expectedSeq += 1;
      }
      if (expectedSeq - 1 !== version.durableSeq) {
        throw new DomainError("CONFLICT", "The document version update history is incomplete");
      }
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
  ) {
    const result = await this.repository.createVersion({
      tenantId: principal.tenantId,
      documentId,
      identityId: principal.identityId,
      ...input,
      requestId,
    });
    if (result.status === "not-found") throw new DomainError("NOT_FOUND", "Document not found");
    if (result.status !== "created")
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
  ) {
    const result = await this.repository.restoreVersion({
      tenantId: principal.tenantId,
      documentId,
      versionId,
      identityId: principal.identityId,
      ...input,
      requestId,
      content: (await this.getVersionContent(principal, documentId, versionId)).content,
    });
    if (result.status === "not-found")
      throw new DomainError("NOT_FOUND", "Document or version not found");
    if (result.status !== "restored")
      throw new DomainError("CONFLICT", "Document changed or version content is unavailable");
    this.sessionRevoker.revokeDocumentSessions(documentId, result.previousGenerationId);
    return presentDocument(result.document);
  }

  async setAcl(
    principal: Principal,
    documentId: string,
    identityId: string,
    actions: readonly DocumentPermissionAction[],
    requestId?: string,
  ) {
    const result = await this.repository.setAcl(
      principal.tenantId,
      documentId,
      principal.identityId,
      identityId,
      actions,
      requestId,
    );
    if (result.status !== "updated") throw new DomainError("NOT_FOUND", "Document not found");
    this.sessionRevoker.revokeDocumentSessions(documentId, result.generationId);
    return { documentId, identityId, actions: result.actions };
  }

  async removeAcl(
    principal: Principal,
    documentId: string,
    identityId: string,
    requestId?: string,
  ): Promise<void> {
    const result = await this.repository.removeAcl(
      principal.tenantId,
      documentId,
      principal.identityId,
      identityId,
      requestId,
    );
    if (result.status !== "updated") throw new DomainError("NOT_FOUND", "Document not found");
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

    const updates = await this.repository.loadUpdates(
      source.id,
      source.generationId,
      source.durableSeq,
    );
    if (updates.length !== source.durableSeq) return { status: "conflict" };

    const sourceDoc = new Y.Doc();
    let expectedSeq = 1;
    try {
      for (const update of updates) {
        if (update.durableSeq !== expectedSeq) return { status: "conflict" };
        Y.applyUpdate(sourceDoc, update.updateBytes, "block-id-repair-source");
        expectedSeq += 1;
      }
      if (expectedSeq - 1 !== source.durableSeq) return { status: "conflict" };

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
    if (writableDocument && document.schemaVersion < this.migration.targetSchemaVersion) {
      document = await this.migrateActiveGeneration(principal, document);
    }
    const canWriteCurrentGeneration = writableDocument !== null;
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
    const updates = await this.repository.loadUpdates(
      source.id,
      source.generationId,
      source.durableSeq,
    );
    const sourceDoc = new Y.Doc();
    let expectedSeq = 1;
    try {
      for (const update of updates) {
        if (update.durableSeq !== expectedSeq) {
          throw new DomainError("CONFLICT", "The document update history is incomplete");
        }
        Y.applyUpdate(sourceDoc, update.updateBytes, "schema-migration-source");
        expectedSeq += 1;
      }
      if (expectedSeq - 1 !== source.durableSeq) {
        throw new DomainError("CONFLICT", "The document update history is incomplete");
      }
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
