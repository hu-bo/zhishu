import type { ChatLiveFrame } from '@zhishu/chat-contracts';

export interface WritingPreview {
  text: string;
  epoch: string;
  attempt: number;
  revision: number;
  index: number;
  incomplete: boolean;
}

/** Missing text stays visibly incomplete until a new revision or durable message replaces it. */
export function appendWritingPreview(
  previous: WritingPreview | undefined,
  frame: ChatLiveFrame,
): WritingPreview {
  const sameAttempt = previous?.epoch === frame.streamEpoch && previous.attempt === frame.attempt;
  if (sameAttempt && previous.revision > frame.revision) return previous;
  const same = sameAttempt && previous.revision === frame.revision;
  if (same && previous.index >= frame.index) return previous;
  const incomplete = same
    ? previous.incomplete || frame.index !== previous.index + 1
    : frame.index !== 0;
  return {
    text: incomplete ? '' : ((same ? previous.text : '') + frame.text).slice(0, 128000),
    epoch: frame.streamEpoch,
    attempt: frame.attempt,
    revision: frame.revision,
    index: frame.index,
    incomplete,
  };
}
