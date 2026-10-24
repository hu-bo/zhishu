import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const id = Type.String({ minLength: 1, maxLength: 160 });
export const SubmitChatMessageSchema = Type.Object(
  {
    clientMessageId: id,
    idempotencyKey: id,
    text: Type.String({ minLength: 1, maxLength: 32000 }),
  },
  { additionalProperties: false },
);
export type SubmitChatMessage = Static<typeof SubmitChatMessageSchema>;
export const RunStatusSchema = Type.Union(
  (
    [
      "queued",
      "running",
      "waiting-approval",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ] as const
  ).map((s) => Type.Literal(s)),
);
export const RunSchema = Type.Object({
  id,
  conversationId: id,
  inputMessageId: id,
  idempotencyKey: id,
  inputHash: Type.String(),
  status: RunStatusSchema,
  attempt: Type.Integer({ minimum: 1 }),
  nativeMessageId: Type.Optional(id),
  turn: Type.Optional(Type.Integer()),
  errorCode: Type.Optional(Type.String()),
  modelCalls: Type.Integer(),
  createdAt: Type.String(),
});
export type Run = Static<typeof RunSchema>;
export const MessageSchema = Type.Object({
  id,
  conversationId: id,
  runId: id,
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  text: Type.String(),
  createdAt: Type.String(),
  status: Type.Union([
    Type.Literal("committed"),
    Type.Literal("pending"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
});
export type ChatMessage = Static<typeof MessageSchema>;
export const ApprovalSchema = Type.Object({
  id,
  runId: id,
  attempt: Type.Integer(),
  action: Type.String(),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  expiresAt: Type.String(),
  status: Type.Union(
    (["pending", "allowed", "rejected", "cancelled", "expired", "unavailable"] as const).map((s) =>
      Type.Literal(s),
    ),
  ),
  decisionId: Type.Optional(id),
  decision: Type.Optional(Type.Union([Type.Literal("allow-once"), Type.Literal("reject")])),
});
export type ChatApproval = Static<typeof ApprovalSchema>;
export const ApprovalDecisionSchema = Type.Object(
  {
    approvalId: id,
    decisionId: id,
    decision: Type.Union([Type.Literal("allow-once"), Type.Literal("reject")]),
  },
  { additionalProperties: false },
);
export type ApprovalDecision = Static<typeof ApprovalDecisionSchema>;
export const ChatSnapshotSchema = Type.Object({
  protocolVersion: Type.Literal(1),
  conversation: Type.Object({ id, title: Type.String(), createdAt: Type.String() }),
  messages: Type.Array(MessageSchema),
  runs: Type.Array(RunSchema),
  approvals: Type.Array(ApprovalSchema),
  cursor: Type.String({ pattern: "^(0|[1-9][0-9]*)$" }),
});
export type ChatSnapshot = Static<typeof ChatSnapshotSchema>;
export const ChatEventSchema = Type.Object({
  type: Type.Literal("snapshot"),
  eventId: id,
  conversationId: id,
  sequence: Type.String({ pattern: "^[1-9][0-9]*$" }),
  snapshot: ChatSnapshotSchema,
});
export type ChatEvent = Static<typeof ChatEventSchema>;
export const ChatLiveFrameSchema = Type.Object({
  type: Type.Literal("assistant.delta"),
  conversationId: id,
  runId: id,
  streamEpoch: id,
  attempt: Type.Integer(),
  revision: Type.Integer(),
  index: Type.Integer(),
  text: Type.String(),
});
export type ChatLiveFrame = Static<typeof ChatLiveFrameSchema>;
export const ChatFrameSchema = Type.Union([
  ChatEventSchema,
  ChatLiveFrameSchema,
  Type.Object({ type: Type.Literal("resync-required"), conversationId: id }),
]);
export type ChatFrame = Static<typeof ChatFrameSchema>;
export function isChatFrame(value: unknown): value is ChatFrame {
  return Value.Check(ChatFrameSchema, value);
}
export function isSubmitChatMessage(value: unknown): value is SubmitChatMessage {
  return Value.Check(SubmitChatMessageSchema, value);
}
export function isChatSnapshot(value: unknown): value is ChatSnapshot {
  return Value.Check(ChatSnapshotSchema, value);
}

/** Complete snapshots replace previews. A gap requires an authorized snapshot fetch. */
export function applyChatEvent(current: ChatSnapshot, event: ChatEvent): ChatSnapshot {
  if (event.conversationId !== current.conversation.id) throw new Error("WRONG_CONVERSATION");
  if (event.snapshot.conversation.id !== event.conversationId)
    throw new Error("WRONG_CONVERSATION");
  if (BigInt(event.sequence) === BigInt(current.cursor)) {
    if (canonical(event.snapshot) !== canonical(current)) throw new Error("CHANGED_DUPLICATE");
    return current;
  }
  if (BigInt(event.sequence) < BigInt(current.cursor)) return current;
  if (BigInt(event.sequence) !== BigInt(current.cursor) + 1n) throw new Error("EVENT_GAP");
  if (event.snapshot.cursor !== event.sequence) throw new Error("INVALID_CURSOR");
  for (const run of current.runs) {
    const next = event.snapshot.runs.find((r) => r.id === run.id);
    if (
      next &&
      ((["completed", "failed", "cancelled"].includes(run.status) && next.status !== run.status) ||
        next.attempt < run.attempt)
    )
      throw new Error("INVALID_TRANSITION");
  }
  for (const message of current.messages) {
    const next = event.snapshot.messages.find((m) => m.id === message.id);
    if (message.status === "committed" && next && next.text !== message.text)
      throw new Error("COMMITTED_MESSAGE_CHANGED");
  }
  return event.snapshot;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
