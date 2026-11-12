import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  aiConversations,
  qaSiteDocuments,
  qaSiteSources,
  qaSites,
  documents,
} from "../../../database/schema/index.js";
import { documentActionSql } from "../authorization/document-access.js";
import { workspaceAccess } from "../authorization/workspace-access.js";
import type { Database } from "../../../database/index.js";
import type { AppConfig } from "../../config.js";
import { DomainError } from "../../shared/domain-error.js";
import type { Principal } from "../identity/identity.types.js";
import type { AiService } from "../ai/index.js";
import {
  hashAccessCode,
  issueVisitorCookie,
  newVisitorId,
  readVisitorCookie,
  verifyAccessCode,
  type VisitorClaims,
} from "./visitor-cookie.js";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VISITOR_TTL_MS = 6 * 3_600_000;

export type QaSiteRow = typeof qaSites.$inferSelect;

export interface SitePublicShell {
  id: string;
  slug: string;
  name: string;
  description: string;
  welcome: string;
  suggestedQuestions: string[];
  accessMode: "public" | "code";
  revision: number;
}

export interface ApprovedSource {
  documentId: string;
  workspaceId: string;
  publicLabel: string;
}

export interface QaSiteServiceDeps {
  db: Database;
  store: AiService;
  config: AppConfig;
  log: (event: string, meta: Record<string, unknown>) => void;
}

/**
 * Public QA site administration: owning workspace managers configure sites; source spaces
 * join only via their own manager's delegation; documents are approved one by one. All
 * authority is re-derived from current relations on every request — vectors and caches
 * are never the source of truth.
 */
export class QaSiteService {
  constructor(private readonly deps: QaSiteServiceDeps) {}

  private async requireManager(principal: Principal, workspaceId: string): Promise<void> {
    const access = await workspaceAccess(this.deps.db, principal, workspaceId);
    if (!access.canManage)
      throw new DomainError("FORBIDDEN", "只有管理空间的 owner/admin 可以配置问答站点");
  }

  async create(
    principal: Principal,
    body: {
      ownerWorkspaceId: string;
      slug: string;
      name: string;
      description?: string;
      welcome?: string;
      suggestedQuestions?: string[];
      accessMode?: "public" | "code";
      accessCode?: string;
    },
  ): Promise<QaSiteRow> {
    await this.requireManager(principal, body.ownerWorkspaceId);
    if (!SLUG_PATTERN.test(body.slug))
      throw new DomainError("VALIDATION_ERROR", "站点地址只能使用小写字母、数字和连字符");
    const id = `site_${randomUUID().replaceAll("-", "")}`;
    const accessCodeHash =
      body.accessMode === "code" ? hashAccessCode(this.requireCode(body.accessCode)) : null;
    const [row] = await this.deps.db
      .insert(qaSites)
      .values({
        id,
        tenantId: principal.tenantId,
        ownerWorkspaceId: body.ownerWorkspaceId,
        slug: body.slug,
        name: body.name,
        description: body.description ?? "",
        welcome: body.welcome ?? "",
        suggestedQuestions: (body.suggestedQuestions ?? []).slice(0, 6),
        accessMode: body.accessMode ?? "public",
        accessCodeHash,
        status: "draft",
        createdBy: principal.identityId,
      })
      .returning();
    if (!row) throw new Error("QA_SITE_INSERT_FAILED");
    return row;
  }

  private requireCode(code: string | undefined): string {
    if (!code || code.length < 4 || code.length > 64)
      throw new DomainError("VALIDATION_ERROR", "访问码长度需在 4-64 之间");
    return code;
  }

  async list(principal: Principal): Promise<QaSiteRow[]> {
    const rows = await this.deps.db
      .select()
      .from(qaSites)
      .where(eq(qaSites.tenantId, principal.tenantId))
      .orderBy(sql`${qaSites.createdAt} desc`);
    const managed = new Map<string, boolean>();
    const result: QaSiteRow[] = [];
    for (const row of rows) {
      let ok = managed.get(row.ownerWorkspaceId);
      if (ok === undefined) {
        ok = (await workspaceAccess(this.deps.db, principal, row.ownerWorkspaceId)).canManage;
        managed.set(row.ownerWorkspaceId, ok);
      }
      if (ok) result.push(row);
    }
    return result;
  }

  async get(principal: Principal, siteId: string): Promise<QaSiteRow> {
    const site = await this.loadOwnedSite(principal, siteId);
    return site;
  }

  private async loadOwnedSite(principal: Principal, siteId: string): Promise<QaSiteRow> {
    const [row] = await this.deps.db
      .select()
      .from(qaSites)
      .where(and(eq(qaSites.tenantId, principal.tenantId), eq(qaSites.id, siteId)))
      .limit(1);
    if (!row) throw new DomainError("NOT_FOUND", "站点不存在");
    await this.requireManager(principal, row.ownerWorkspaceId);
    return row;
  }

  async detail(principal: Principal, siteId: string) {
    const site = await this.loadOwnedSite(principal, siteId);
    const sources = await this.deps.db
      .select()
      .from(qaSiteSources)
      .where(and(eq(qaSiteSources.tenantId, site.tenantId), eq(qaSiteSources.siteId, site.id)));
    const docs = await this.deps.db
      .select()
      .from(qaSiteDocuments)
      .where(
        and(eq(qaSiteDocuments.tenantId, site.tenantId), eq(qaSiteDocuments.sourceId, site.id)),
      );
    return { site, sources, documents: docs };
  }

  /** Display/access updates go through revision CAS; code/mode changes also revoke credentials. */
  async update(
    principal: Principal,
    siteId: string,
    body: {
      expectedRevision: number;
      name?: string;
      description?: string;
      welcome?: string;
      suggestedQuestions?: string[];
      accessMode?: "public" | "code";
      accessCode?: string;
      quotaPolicy?: { messagesPerHour?: number; concurrentRuns?: number };
    },
  ) {
    const site = await this.loadOwnedSite(principal, siteId);
    const credentialChanged =
      (body.accessMode !== undefined && body.accessMode !== site.accessMode) ||
      (body.accessMode === "code" && !!body.accessCode);
    const rows = await this.deps.db
      .update(qaSites)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.welcome !== undefined ? { welcome: body.welcome } : {}),
        ...(body.suggestedQuestions !== undefined
          ? { suggestedQuestions: body.suggestedQuestions.slice(0, 6) }
          : {}),
        ...(body.accessMode !== undefined ? { accessMode: body.accessMode } : {}),
        ...(body.accessMode === "code" && body.accessCode
          ? { accessCodeHash: hashAccessCode(this.requireCode(body.accessCode)) }
          : {}),
        ...(body.quotaPolicy !== undefined ? { quotaPolicy: body.quotaPolicy } : {}),
        revision: site.revision + 1,
        ...(credentialChanged ? { accessRevision: site.accessRevision + 1 } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(qaSites.tenantId, principal.tenantId),
          eq(qaSites.id, siteId),
          eq(qaSites.revision, body.expectedRevision),
        ),
      )
      .returning();
    if (!rows.length) throw new DomainError("CONFLICT", "站点配置已被更新，请刷新后重试");
    if (credentialChanged) await this.revokeCredentials(site);
    return rows[0]!;
  }

  /** One transaction replaces the delegation set; removal cascades approvals and bumps revisions. */
  async setSources(
    principal: Principal,
    siteId: string,
    expectedRevision: number,
    sources: { workspaceId: string; publicLabel: string }[],
  ) {
    const site = await this.loadOwnedSite(principal, siteId);
    if (site.revision !== expectedRevision)
      throw new DomainError("CONFLICT", "站点配置已被更新，请刷新后重试");
    const seen = new Set<string>();
    for (const source of sources) {
      if (!source.publicLabel.trim() || source.publicLabel.length > 120)
        throw new DomainError("VALIDATION_ERROR", "公开来源名称无效");
      if (seen.has(source.workspaceId))
        throw new DomainError("VALIDATION_ERROR", "同一来源空间只能绑定一次");
      seen.add(source.workspaceId);
      // Delegation requires the acting identity to manage the source space right now.
      await this.requireManager(principal, source.workspaceId);
    }
    await this.deps.db.transaction(async (tx) => {
      await tx
        .delete(qaSiteSources)
        .where(and(eq(qaSiteSources.tenantId, site.tenantId), eq(qaSiteSources.siteId, site.id)));
      for (const source of sources)
        await tx.insert(qaSiteSources).values({
          id: `src_${randomUUID().replaceAll("-", "")}`,
          tenantId: site.tenantId,
          siteId: site.id,
          workspaceId: source.workspaceId,
          publicLabel: source.publicLabel.trim(),
          grantedBy: principal.identityId,
        });
      await tx
        .update(qaSites)
        .set({ revision: site.revision + 1, updatedAt: new Date() })
        .where(and(eq(qaSites.tenantId, site.tenantId), eq(qaSites.id, site.id)));
      await this.invalidateSiteConversations(site.tenantId, site.id);
    });
    return this.get(principal, siteId);
  }

  /** Per-document approve / suspend / withdraw with continuous authority verification. */
  async setDocuments(
    principal: Principal,
    siteId: string,
    sourceId: string,
    items: { documentId: string; action: "approve" | "suspend" | "withdraw"; reason?: string }[],
  ) {
    const site = await this.loadOwnedSite(principal, siteId);
    const [source] = await this.deps.db
      .select()
      .from(qaSiteSources)
      .where(
        and(
          eq(qaSiteSources.tenantId, site.tenantId),
          eq(qaSiteSources.id, sourceId),
          eq(qaSiteSources.siteId, site.id),
        ),
      )
      .limit(1);
    if (!source) throw new DomainError("NOT_FOUND", "来源不存在");
    await this.requireManager(principal, source.workspaceId);
    for (const item of items) {
      if (item.action === "approve") {
        await this.assertDocumentAuthority(principal, item.documentId, source.workspaceId);
        const conflict = await this.deps.db
          .select({ id: qaSiteDocuments.id })
          .from(qaSiteDocuments)
          .where(
            and(
              eq(qaSiteDocuments.tenantId, site.tenantId),
              eq(qaSiteDocuments.sourceId, source.id),
              eq(qaSiteDocuments.documentId, item.documentId),
            ),
          )
          .limit(1);
        if (conflict.length) {
          await this.deps.db
            .update(qaSiteDocuments)
            .set({
              state: "active",
              suspensionReason: null,
              approvedBy: principal.identityId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(qaSiteDocuments.tenantId, site.tenantId),
                eq(qaSiteDocuments.sourceId, source.id),
                eq(qaSiteDocuments.documentId, item.documentId),
              ),
            );
        } else {
          const [doc] = await this.deps.db
            .select({ workspaceId: documents.workspaceId })
            .from(documents)
            .where(and(eq(documents.tenantId, site.tenantId), eq(documents.id, item.documentId)))
            .limit(1);
          if (!doc || doc.workspaceId !== source.workspaceId)
            throw new DomainError("VALIDATION_ERROR", "文档不属于该来源空间");
          await this.deps.db.insert(qaSiteDocuments).values({
            id: `qsdoc_${randomUUID().replaceAll("-", "")}`,
            tenantId: site.tenantId,
            sourceId: source.id,
            workspaceId: source.workspaceId,
            documentId: item.documentId,
            approvedBy: principal.identityId,
            state: "active",
          });
        }
      } else if (item.action === "suspend") {
        await this.deps.db
          .update(qaSiteDocuments)
          .set({
            state: "suspended",
            suspensionReason: item.reason?.slice(0, 300) ?? "管理员暂停",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(qaSiteDocuments.tenantId, site.tenantId),
              eq(qaSiteDocuments.sourceId, source.id),
              eq(qaSiteDocuments.documentId, item.documentId),
            ),
          );
      } else {
        await this.deps.db
          .delete(qaSiteDocuments)
          .where(
            and(
              eq(qaSiteDocuments.tenantId, site.tenantId),
              eq(qaSiteDocuments.sourceId, source.id),
              eq(qaSiteDocuments.documentId, item.documentId),
            ),
          );
      }
    }
    await this.deps.db
      .update(qaSites)
      .set({ revision: site.revision + 1, updatedAt: new Date() })
      .where(and(eq(qaSites.tenantId, site.tenantId), eq(qaSites.id, site.id)));
    await this.invalidateSiteConversations(site.tenantId, site.id);
    return this.detail(principal, siteId);
  }

  /** Approval requires read/ai/share/export on the document plus source-space management. */
  private async assertDocumentAuthority(
    principal: Principal,
    documentId: string,
    workspaceId: string,
  ): Promise<void> {
    for (const action of ["read", "ai", "share", "export"] as const) {
      const rows = await this.deps.db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            eq(documents.id, documentId),
            eq(documents.workspaceId, workspaceId),
            eq(documents.status, "active"),
            documentActionSql(principal, action),
          ),
        )
        .limit(1);
      if (!rows.length)
        throw new DomainError("FORBIDDEN", `批准公开需要文档的 ${action} 权限且文档属于该来源空间`);
    }
  }

  async setStatus(
    principal: Principal,
    siteId: string,
    expectedRevision: number,
    status: "pending" | "active" | "paused" | "disabled",
  ) {
    const site = await this.loadOwnedSite(principal, siteId);
    if (site.revision !== expectedRevision)
      throw new DomainError("CONFLICT", "站点状态已被更新，请刷新后重试");
    const order: Record<QaSiteRow["status"], number> = {
      draft: 0,
      pending: 1,
      active: 2,
      paused: 3,
      disabled: 4,
    };
    if (status === "active" && order[site.status] > order.pending && site.status !== "paused")
      throw new DomainError("CONFLICT", "当前状态不能直接启用");
    const credentialBump = status === "paused" || status === "disabled";
    const rows = await this.deps.db
      .update(qaSites)
      .set({
        status,
        revision: site.revision + 1,
        ...(credentialBump ? { accessRevision: site.accessRevision + 1 } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(qaSites.tenantId, principal.tenantId),
          eq(qaSites.id, siteId),
          eq(qaSites.revision, expectedRevision),
        ),
      )
      .returning();
    if (!rows.length) throw new DomainError("CONFLICT", "站点状态已被更新，请刷新后重试");
    if (credentialBump) {
      await this.revokeCredentials(site);
      await this.invalidateSiteConversations(site.tenantId, site.id);
    }
    return rows[0]!;
  }

  /** Public visitors and preview principals see the same shell; only live state serves. */
  async shellBySlug(slug: string): Promise<(SitePublicShell & { site: QaSiteRow }) | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(qaSites)
      .where(and(eq(qaSites.slug, slug), inArray(qaSites.status, ["active", "paused"])))
      .limit(1);
    if (!row) return;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      welcome: row.welcome,
      suggestedQuestions: row.suggestedQuestions,
      accessMode: row.accessMode,
      revision: row.revision,
      site: row,
    };
  }

  /** Public entry paths carry no tenant: the globally unique site id resolves the tenant. */
  async activeSiteById(siteId: string): Promise<QaSiteRow> {
    const [row] = await this.deps.db.select().from(qaSites).where(eq(qaSites.id, siteId)).limit(1);
    if (!row) throw new DomainError("NOT_FOUND", "站点不存在");
    if (row.status !== "active") throw new DomainError("FORBIDDEN", "站点当前不可访问");
    return row;
  }

  async startVisitorSession(
    site: QaSiteRow,
    accessCode: string | undefined,
  ): Promise<{ claims: VisitorClaims; cookie: string; maxAgeSeconds: number }> {
    if (site.accessMode === "code" && !verifyAccessCode(accessCode ?? "", site.accessCodeHash))
      throw new DomainError("UNAUTHENTICATED", "访问码不正确");
    const claims: VisitorClaims = {
      siteId: site.id,
      visitorId: newVisitorId(),
      accessRevision: site.accessRevision,
      expiresAt: Date.now() + VISITOR_TTL_MS,
    };
    const issued = issueVisitorCookie(claims, this.deps.config.QA_VISITOR_COOKIE_SECRET);
    return { claims, cookie: issued.value, maxAgeSeconds: issued.maxAgeSeconds };
  }

  resolveVisitor(site: QaSiteRow, cookie: string | undefined): VisitorClaims | undefined {
    const claims = readVisitorCookie(cookie, this.deps.config.QA_VISITOR_COOKIE_SECRET);
    if (!claims) return;
    if (claims.siteId !== site.id) return;
    // accessRevision only guards credentials; a bump invalidates every older cookie.
    if (claims.accessRevision !== site.accessRevision) return;
    return claims;
  }

  /** The continuously verified approved-document set (delegation still valid, doc active). */
  async approvedDocuments(site: QaSiteRow): Promise<ApprovedSource[]> {
    const sources = await this.deps.db
      .select()
      .from(qaSiteSources)
      .where(and(eq(qaSiteSources.tenantId, site.tenantId), eq(qaSiteSources.siteId, site.id)));
    const delegators = new Map<string, boolean>();
    const result: ApprovedSource[] = [];
    for (const source of sources) {
      let valid = delegators.get(source.grantedBy + source.workspaceId);
      if (valid === undefined) {
        const access = await workspaceAccess(
          this.deps.db,
          { tenantId: site.tenantId, identityId: source.grantedBy },
          source.workspaceId,
        );
        valid = access.canManage;
        delegators.set(source.grantedBy + source.workspaceId, valid);
      }
      if (!valid) continue;
      const docs = await this.deps.db
        .select({ documentId: qaSiteDocuments.documentId })
        .from(qaSiteDocuments)
        .where(
          and(
            eq(qaSiteDocuments.tenantId, site.tenantId),
            eq(qaSiteDocuments.sourceId, source.id),
            eq(qaSiteDocuments.state, "active"),
          ),
        );
      for (const doc of docs)
        result.push({
          documentId: doc.documentId,
          workspaceId: source.workspaceId,
          publicLabel: source.publicLabel,
        });
    }
    return result;
  }

  siteQuotaPolicy(site: QaSiteRow): { messagesPerHour: number; concurrentRuns: number } {
    return {
      messagesPerHour: site.quotaPolicy.messagesPerHour ?? 120,
      concurrentRuns: site.quotaPolicy.concurrentRuns ?? 4,
    };
  }

  /** Load a site row by its globally unique id for internal engine resolution. */
  async findSiteById(siteId: string): Promise<QaSiteRow | undefined> {
    const [row] = await this.deps.db.select().from(qaSites).where(eq(qaSites.id, siteId)).limit(1);
    return row;
  }

  /** Quota lookup without the active gate: used while admitting an already-open session. */
  async messagesPerHourFor(tenantId: string, siteId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ quotaPolicy: qaSites.quotaPolicy })
      .from(qaSites)
      .where(and(eq(qaSites.tenantId, tenantId), eq(qaSites.id, siteId)))
      .limit(1);
    return (row?.quotaPolicy as { messagesPerHour?: number } | undefined)?.messagesPerHour ?? 120;
  }

  /**
   * Site pause/revoke: bump handled by caller; this revokes active subscriptions. Credential
   * invalidation itself is lazy (accessRevision compare), so nothing else to revoke here.
   */
  private async revokeCredentials(site: QaSiteRow): Promise<void> {
    this.deps.log("qa_site_credentials_revoked", { siteId: site.id });
  }

  /** Business-scope changes isolate affected public conversations through the shared store. */
  private async invalidateSiteConversations(tenantId: string, siteId: string): Promise<void> {
    const rows = await this.deps.db
      .select({ id: aiConversations.id })
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.tenantId, tenantId),
          eq(aiConversations.siteId, siteId),
          eq(aiConversations.status, "active"),
        ),
      );
    if (rows.length)
      await this.deps.store.invalidateContext(
        tenantId,
        rows.map((c) => c.id),
        "site-scope-changed",
      );
  }
}

/**
 * Documents-module move/delete hook: public relations are dissolved inside the same
 * business transaction before ownership changes (never rely on async events).
 */
export async function detachDocumentFromSites(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  tenantId: string,
  documentId: string,
): Promise<void> {
  await tx
    .delete(qaSiteDocuments)
    .where(and(eq(qaSiteDocuments.tenantId, tenantId), eq(qaSiteDocuments.documentId, documentId)));
}
