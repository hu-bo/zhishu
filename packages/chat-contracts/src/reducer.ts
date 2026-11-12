import { Value } from "@sinclair/typebox/value";
import { canonicalJson } from "@zhishu/ai-contracts";
import { AiEventSchemas } from "./session.js";
import type { AiEvent, ConversationSnapshot, Message, Run, RunStatus } from "./session.js";

/** Terminal run statuses never move backwards when events replay out of order. */
const TERMINAL: ReadonlySet<RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);
const ORDER: readonly RunStatus[] = [
  "queued",
  "running",
  "waiting-approval",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
];

/**
 * A durable product event is applied to the current authorized snapshot. Events carry only
 * the changed entity; the caller refetches a full snapshot on gap, resync or permission change.
 * `applyAiEvent` returns null when the event cannot be trusted against the current state.
 */
export function applyAiEvent(
  current: ConversationSnapshot,
  event: AiEvent,
): ConversationSnapshot | null {
  if (!Value.Check(AiEventSchemas[event.type], event)) return null;
  if (event.conversationId !== current.conversation.id) return null;
  if (event.purpose !== current.conversation.purpose) return null;
  // The durable cursor is monotonic; only the immediate next sequence advances it.
  if (BigInt(event.sequence) !== BigInt(current.cursor) + 1n) return null;
  switch (event.type) {
    case "message.created": {
      const existing = current.messages.find((m) => m.id === event.payload.message.id);
      if (existing && canonicalJson(existing) !== canonicalJson(event.payload.message)) return null;
      return commit(current, event, {
        messages: existing
          ? current.messages
          : mergeMessage(current.messages, event.payload.message),
      });
    }
    case "run.updated": {
      const existing = current.runs.find((r) => r.id === event.payload.run.id);
      if (existing) {
        if (canonicalJson(existing) === canonicalJson(event.payload.run))
          return commit(current, event, {});
        // A terminal or regressing redelivery means the client state is not trustworthy.
        if (
          TERMINAL.has(existing.status) ||
          ORDER.indexOf(event.payload.run.status) < ORDER.indexOf(existing.status)
        )
          return null;
      }
      return commit(current, event, { runs: mergeRun(current.runs, event.payload.run) });
    }
    case "artifact.created":
      return commit(current, event, {
        artifacts: current.artifacts.some((a) => a.id === event.payload.artifact.id)
          ? current.artifacts
          : [...current.artifacts, event.payload.artifact],
      });
    case "artifact.application-updated": {
      const { artifactId, applicationState, reviewRevision, receipt } = event.payload;
      let touched = false;
      const artifacts = current.artifacts.map((artifact) => {
        if (artifact.id !== artifactId) return artifact;
        touched = true;
        return {
          ...artifact,
          applicationState,
          ...(reviewRevision !== undefined ? { reviewRevision } : {}),
          ...(receipt !== undefined ? { receipt } : {}),
        };
      });
      if (!touched) return null;
      return commit(current, event, { artifacts });
    }
    case "scope.changed": {
      const { contextRevision, scope } = event.payload;
      return commit(current, event, {
        conversation: { ...current.conversation, contextRevision, scope },
      });
    }
    default:
      return null;
  }
}

function commit(
  current: ConversationSnapshot,
  event: AiEvent,
  patch: Partial<Omit<ConversationSnapshot, "conversation" | "cursor">> & {
    conversation?: ConversationSnapshot["conversation"];
  },
): ConversationSnapshot {
  return {
    ...current,
    ...patch,
    conversation: patch.conversation ?? {
      ...current.conversation,
      eventSequence: event.sequence,
      updatedAt: event.createdAt,
    },
    cursor: event.sequence,
  };
}

function mergeMessage(messages: Message[], next: Message): Message[] {
  if (messages.some((m) => m.id === next.id)) return messages;
  return [...messages, next].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  );
}

function mergeRun(runs: Run[], next: Run): Run[] {
  const existing = runs.find((r) => r.id === next.id);
  if (!existing) return [...runs, next];
  if (TERMINAL.has(existing.status) && existing.status !== next.status) return runs;
  if (ORDER.indexOf(next.status) < ORDER.indexOf(existing.status)) return runs;
  return runs.map((r) => (r.id === next.id ? next : r));
}
