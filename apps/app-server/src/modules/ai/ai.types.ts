import type {
  ConversationSnapshot,
  Message,
  MessagePart,
  Run,
  RunStatus,
  Artifact,
} from "@zhishu/chat-contracts";
import type {
  AssistantExecution,
  AssistantRunContext,
  ProposalApplicationState,
  ProposalReview,
  RunUsage,
  ScopeSelection,
  ToolApproval,
} from "@zhishu/ai-contracts";
import type { StructureReceipt } from "@zhishu/document-contracts";

/** Pure row/DTO shapes shared inside the ai module boundary. */

export interface ConversationRow {
  id: string;
  tenantId: string;
  identityId: string | null;
  visitorId: string | null;
  siteId: string | null;
  scopeSelection: ScopeSelection;
  contextRevision: number;
  targetDocumentId: string | null;
  configurationId: string | null;
  creationKey: string | null;
  eventSequence: bigint;
  status: "active" | "target-unavailable" | "closed";
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunRow {
  id: string;
  tenantId: string;
  conversationId: string;
  idempotencyKey: string;
  inputHash: string;
  context: AssistantRunContext;
  status: RunStatus;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  fencingToken: bigint | null;
  execution: AssistantExecution | null;
  usage: RunUsage;
  errorCode: string | null;
  cancelRequested: boolean;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface MessageRow {
  id: string;
  tenantId: string;
  conversationId: string;
  runId: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  clientMessageId: string | null;
  state: "staged" | "committed" | "withdrawn";
  generationAttempt: number | null;
  createdAt: Date;
  committedAt: Date | null;
}

export interface ArtifactRow {
  id: string;
  tenantId: string;
  conversationId: string;
  runId: string;
  producerCallId: string;
  resultIndex: number;
  kind: "evidence" | "draft" | "proposal" | "image";
  schemaVersion: number;
  state: "staged" | "committed" | "withdrawn";
  payload: unknown;
  evidenceRefs: { evidenceArtifactId: string; evidenceId: string }[];
  reviewRevision: number | null;
  review: ProposalReview | null;
  applicationState: ProposalApplicationState | null;
  receipt: StructureReceipt | null;
  createdAt: Date;
}

export const conversationDto = (
  row: ConversationRow,
  title: string,
): import("@zhishu/chat-contracts").Conversation => ({
  id: row.id,
  title,
  scope: row.scopeSelection,
  contextRevision: row.contextRevision,
  status: row.status,
  targetDocumentId: row.targetDocumentId,
  siteId: row.siteId ?? undefined,
  eventSequence: row.eventSequence.toString(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const runContextRevision = (run: RunRow): number => run.context.contextRevision;

export const runDto = (run: RunRow): Run => ({
  id: run.id,
  conversationId: run.conversationId,
  status: run.status,
  attempt: run.attempt,
  contextRevision: runContextRevision(run),
  inputHash: run.inputHash,
  errorCode: run.errorCode ?? undefined,
  usage: run.usage,
  cancelRequested: run.cancelRequested || undefined,
  approval: run.execution?.approval ?? undefined,
  createdAt: run.createdAt.toISOString(),
  updatedAt: run.updatedAt.toISOString(),
});

export const messageDto = (row: MessageRow): Message => ({
  id: row.id,
  conversationId: row.conversationId,
  runId: row.runId,
  role: row.role,
  parts: row.parts,
  clientMessageId: row.clientMessageId ?? undefined,
  createdAt: row.createdAt.toISOString(),
  committedAt: row.committedAt?.toISOString(),
});

export const artifactDto = (row: ArtifactRow): Artifact => ({
  id: row.id,
  conversationId: row.conversationId,
  runId: row.runId,
  kind: row.kind,
  schemaVersion: row.schemaVersion,
  // evidenceRefs stays server-side bookkeeping: clients resolve citations from message
  // parts and load bodies through GET /artifacts/:id, never from this list.
  reviewRevision: row.reviewRevision ?? undefined,
  review: row.review ?? undefined,
  applicationState: row.applicationState ?? undefined,
  receipt: row.receipt ?? undefined,
});

export type { ConversationSnapshot, ToolApproval };
