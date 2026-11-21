import type { PreviewFrame, PreviewTool } from "./session.js";

/** One streamed tool call inside a live preview; transient process fact only. */
export type ToolPreview = PreviewTool;

/** Merge bookkeeping for one dense delta channel (text or thinking). */
interface DeltaChannel {
  value: string;
  revision: number;
  index: number;
  incomplete: boolean;
}

/** Accumulated live preview for one run stream; never a durable answer. */
export interface PreviewState {
  /** Visible answer/draft preview merged from "text" deltas. */
  text: string;
  /** Reasoning preview merged from "thinking" deltas; preview-only, never persisted. */
  thinking: string;
  /** Tool calls observed in this attempt, in first-seen order. */
  tools: readonly ToolPreview[];
  epoch: string;
  attempt: number;
  contextRevision: number;
  revision: number;
  index: number;
  incomplete: boolean;
  thinkingRevision: number;
  thinkingIndex: number;
  thinkingIncomplete: boolean;
}

/** Bounded tool log per preview: the newest calls stay visible under a chatty loop. */
const TOOL_LIMIT = 32;

const TOOL_STATUS_ORDER = {
  running: 0,
  completed: 1,
  failed: 1,
} as const satisfies Record<ToolPreview["status"], number>;

/** Fresh state for a frame from an unseen stream: no channel has merged anything yet. */
const freshState = (frame: PreviewFrame): PreviewState => ({
  text: "",
  thinking: "",
  tools: [],
  epoch: frame.streamEpoch,
  attempt: frame.attempt,
  contextRevision: frame.contextRevision,
  // Revision 0 never matches a frame revision, so the first delta of each channel restarts cleanly.
  revision: 0,
  index: 0,
  incomplete: false,
  thinkingRevision: 0,
  thinkingIndex: 0,
  thinkingIncomplete: false,
});

/**
 * Shared dense-delta merge for one channel: stale frames are dropped, gaps mark the
 * channel incomplete (its accumulated text is cleared) until a new revision or the
 * durable message replaces it.
 */
function applyDeltaChannel(previous: DeltaChannel, frame: PreviewFrame): DeltaChannel {
  const text = frame.text ?? "";
  if (previous.revision > frame.revision) return previous;
  const same = previous.revision === frame.revision;
  if (same && previous.index >= frame.index) return previous;
  const incomplete = same
    ? previous.incomplete || frame.index !== previous.index + 1
    : frame.index !== 0;
  const base = same ? previous.value : "";
  return {
    value: incomplete ? "" : (base + text).slice(0, 128_000),
    revision: frame.revision,
    index: frame.index,
    incomplete,
  };
}

function applyToolChannel(tools: readonly ToolPreview[], next: ToolPreview) {
  const existing = tools.find((tool) => tool.id === next.id);
  if (!existing) return [...tools, next].slice(-TOOL_LIMIT);
  // A settled status never regresses when frames replay or interleave.
  if (TOOL_STATUS_ORDER[existing.status] > TOOL_STATUS_ORDER[next.status]) return tools;
  if (existing.status === next.status && existing.name === next.name) return tools;
  return tools.map((tool) => (tool.id === next.id ? next : tool));
}

/**
 * Shared pure merger for live preview frames used by assistant hosts.
 * Missing text stays visibly incomplete until a new revision or the durable message replaces it.
 * Tool and thinking channels merge independently; stage frames merge nothing here (progress label).
 */
export function applyPreviewFrame(
  previous: PreviewState | undefined,
  frame: PreviewFrame,
): PreviewState | undefined {
  if (frame.channel === "stage") return previous;
  const sameAttempt =
    !!previous &&
    previous.epoch === frame.streamEpoch &&
    previous.attempt === frame.attempt &&
    previous.contextRevision === frame.contextRevision;

  if (frame.channel === "tool") {
    if (!frame.tool) return previous;
    const base = sameAttempt && previous ? previous : freshState(frame);
    const tools = applyToolChannel(base.tools, frame.tool);
    return tools === base.tools ? base : { ...base, tools };
  }

  if (frame.text === undefined) return previous;
  const base = sameAttempt && previous ? previous : freshState(frame);
  if (frame.channel === "thinking") {
    const merged = applyDeltaChannel(
      {
        value: base.thinking,
        revision: base.thinkingRevision,
        index: base.thinkingIndex,
        incomplete: base.thinkingIncomplete,
      },
      frame,
    );
    if (
      merged.revision === base.thinkingRevision &&
      merged.index === base.thinkingIndex &&
      merged.value === base.thinking
    )
      return base;
    return {
      ...base,
      thinking: merged.value,
      thinkingRevision: merged.revision,
      thinkingIndex: merged.index,
      thinkingIncomplete: merged.incomplete,
    };
  }
  const merged = applyDeltaChannel(
    { value: base.text, revision: base.revision, index: base.index, incomplete: base.incomplete },
    frame,
  );
  if (
    merged.revision === base.revision &&
    merged.index === base.index &&
    merged.value === base.text
  )
    return base;
  return {
    ...base,
    text: merged.value,
    revision: merged.revision,
    index: merged.index,
    incomplete: merged.incomplete,
  };
}
