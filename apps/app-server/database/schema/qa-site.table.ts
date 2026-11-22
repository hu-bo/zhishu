import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { documents, workspaces } from "./document.table.js";

/**
 * Public QA sites. Management belongs to the owning workspace's current owner/admin; the site
 * is the boundary for delegated source spaces and per-document public approval.
 */
export const qaSites = pgTable(
  "qa_sites",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    ownerWorkspaceId: text("owner_workspace_id").notNull(),
    // /ask/$slug carries no user header, so the slug must be globally unique, keeping disabled-site placeholders.
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    welcome: text("welcome").notNull().default(""),
    suggestedQuestions: jsonb("suggested_questions").$type<string[]>().notNull().default([]),
    accessMode: text("access_mode").$type<"public" | "code">().notNull().default("public"),
    accessCodeHash: text("access_code_hash"),
    status: text("status")
      .$type<"draft" | "pending" | "active" | "paused" | "disabled">()
      .notNull()
      .default("draft"),
    // Business configuration revision: source/approval/display changes advance this.
    revision: integer("revision").notNull().default(1),
    // Credential revision: pause/revoke, access code or access mode changes advance this only.
    accessRevision: integer("access_revision").notNull().default(1),
    quotaPolicy: jsonb("quota_policy")
      .$type<{ messagesPerHour?: number; concurrentRuns?: number; maxScopeDocuments?: number }>()
      .notNull()
      .default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    uniqueIndex("qa_sites_slug_uq").on(t.slug),
    // Public entry routes carry no user: the site id itself must resolve one row.
    uniqueIndex("qa_sites_id_uq").on(t.id),
    foreignKey({
      name: "qa_sites_owner_workspace_fk",
      columns: [t.userId, t.ownerWorkspaceId],
      foreignColumns: [workspaces.userId, workspaces.id],
    }),
    check("qa_sites_access_mode_check", sql`${t.accessMode} in ('public','code')`),
    check(
      "qa_sites_access_code_check",
      sql`${t.accessMode} <> 'code' or ${t.accessCodeHash} is not null`,
    ),
    check(
      "qa_sites_status_check",
      sql`${t.status} in ('draft','pending','active','paused','disabled')`,
    ),
    check("qa_sites_revision_check", sql`${t.revision} >= 1 and ${t.accessRevision} >= 1`),
    index("qa_sites_user_idx").on(t.userId, t.ownerWorkspaceId, t.createdAt),
  ],
);

/** Delegated source spaces. grantedBy is the continuously-verified delegating admin identity. */
export const qaSiteSources = pgTable(
  "qa_site_sources",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    siteId: text("site_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    publicLabel: text("public_label").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    uniqueIndex("qa_site_sources_site_workspace_uq").on(t.userId, t.siteId, t.workspaceId),
    // Supports the per-document composite FK that proves document-to-source workspace binding.
    uniqueIndex("qa_site_sources_user_id_workspace_uq").on(t.userId, t.id, t.workspaceId),
    foreignKey({
      name: "qa_site_sources_site_fk",
      columns: [t.userId, t.siteId],
      foreignColumns: [qaSites.userId, qaSites.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "qa_site_sources_workspace_fk",
      columns: [t.userId, t.workspaceId],
      foreignColumns: [workspaces.userId, workspaces.id],
    }),
    index("qa_site_sources_workspace_idx").on(t.userId, t.workspaceId),
  ],
);

/** Per-document public approval, tied to its delegating source and real workspace ownership. */
export const qaSiteDocuments = pgTable(
  "qa_site_documents",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    sourceId: text("source_id").notNull(),
    // Denormalized so the composite FK can prove the document really lives in the source workspace.
    workspaceId: text("workspace_id").notNull(),
    documentId: text("document_id").notNull(),
    approvedBy: text("approved_by").notNull(),
    state: text("state").$type<"active" | "suspended">().notNull().default("active"),
    suspensionReason: text("suspension_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    uniqueIndex("qa_site_documents_source_document_uq").on(t.userId, t.sourceId, t.documentId),
    foreignKey({
      name: "qa_site_documents_source_fk",
      columns: [t.userId, t.sourceId, t.workspaceId],
      foreignColumns: [qaSiteSources.userId, qaSiteSources.id, qaSiteSources.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "qa_site_documents_document_fk",
      columns: [t.userId, t.workspaceId, t.documentId],
      foreignColumns: [documents.userId, documents.workspaceId, documents.id],
    }),
    check("qa_site_documents_state_check", sql`${t.state} in ('active','suspended')`),
    check(
      "qa_site_documents_suspension_check",
      sql`${t.state} <> 'suspended' or ${t.suspensionReason} is not null`,
    ),
    index("qa_site_documents_document_idx").on(t.userId, t.documentId),
    index("qa_site_documents_workspace_idx").on(t.userId, t.workspaceId, t.state),
  ],
);
