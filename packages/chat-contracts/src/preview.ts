import type { PreviewFrame } from "./session.js";

/** Accumulated live preview for one run stream; never a durable answer. */
export interface PreviewState {
  text: string;
  epoch: string;
  attempt: number;
  contextRevision: number;
  revision: number;
  index: number;
  incomplete: boolean;
}

/**
 * Shared pure merger for text-preview frames used by both writing and QA hosts.
 * Missing text stays visibly incomplete until a new revision or the durable message replaces it.
 */
export function applyPreviewFrame(
  previous: PreviewState | undefined,
  frame: PreviewFrame,
): PreviewState | undefined {
  if (frame.channel !== "text" || frame.text === undefined) return previous;
  const sameAttempt =
    previous?.epoch === frame.streamEpoch &&
    previous.attempt === frame.attempt &&
    previous.contextRevision === frame.contextRevision;
  if (sameAttempt && previous.revision > frame.revision) return previous;
  const same = sameAttempt && previous.revision === frame.revision;
  if (same && previous.index >= frame.index) return previous;
  const incomplete = same
    ? previous.incomplete || frame.index !== previous.index + 1
    : frame.index !== 0;
  return {
    text: incomplete ? "" : ((same ? previous.text : "") + frame.text).slice(0, 128_000),
    epoch: frame.streamEpoch,
    attempt: frame.attempt,
    contextRevision: frame.contextRevision,
    revision: frame.revision,
    index: frame.index,
    incomplete,
  };
}
