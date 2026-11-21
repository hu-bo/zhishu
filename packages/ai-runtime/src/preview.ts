import type { TurnHost } from "@zhishu/dsh-agent";

/**
 * Live-preview orchestration. The kernel forwards raw stream chunks by channel; this layer
 * decides what is presentable: model text and reasoning pass through, while the user-facing
 * final text of Zhishu content tools lives inside streamed tool arguments (the answer or
 * proposal JSON). Decoding those argument deltas into the text channel is what gives
 * assistant turns a typing effect instead of one render at completion.
 */

/**
 * Value paths whose streamed text is user-facing content, per tool name.
 * "*" marks an array position. Mirrors the @zhishu/ai-plugins output schemas:
 * the rag answer tool submits { text }, the writing/draft tools submit { blocks: [{ text }] }.
 */
const BLOCK_TEXT = [["blocks", "*", "text"]] as const;
const ANSWER_TEXT = [["text"]] as const;

const TOOL_ARGUMENT_TEXTS = {
  answer_with_citations: ANSWER_TEXT,
  compose_document: BLOCK_TEXT,
  continue_document: BLOCK_TEXT,
  rewrite_paragraph: BLOCK_TEXT,
  rewrite_document: BLOCK_TEXT,
  summarize_document: BLOCK_TEXT,
  translate_paragraph: BLOCK_TEXT,
  research_document: BLOCK_TEXT,
  draft_document: BLOCK_TEXT,
} as const satisfies Record<string, readonly (readonly string[])[]>;

interface ObjectFrame {
  kind: "object";
  key: string | null;
}
interface ArrayFrame {
  kind: "array";
}
type Container = ObjectFrame | ArrayFrame;

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Streaming decoder over one tool's partial JSON argument stream: every time a string
 * value at a configured path grows, the newly visible characters are returned. Preview
 * best effort — a malformed or truncated prefix yields less, never more.
 */
export function createArgumentTextExtractor(paths: readonly (readonly string[])[]): {
  push(delta: string): string;
} {
  const stack: Container[] = [];
  let inString = false;
  let stringIsKey = false;
  let stringMatched = false;
  let escaped = false;
  let unicodeHex: string | null = null;
  let keyBuffer = "";
  const pathMatches = (path: readonly string[]) =>
    paths.some((spec) => spec.length === path.length && spec.every((part, i) => part === path[i]));
  return {
    push(delta: string): string {
      let out = "";
      for (const ch of delta) {
        if (inString) {
          if (unicodeHex !== null) {
            if (/[0-9a-fA-F]/.test(ch)) {
              unicodeHex += ch;
              if (unicodeHex.length === 4) {
                const decoded = String.fromCharCode(Number.parseInt(unicodeHex, 16));
                unicodeHex = null;
                if (stringMatched) out += decoded;
                else if (stringIsKey) keyBuffer += decoded;
              }
              continue;
            }
            // Truncated escape: stop decoding this value rather than emit noise.
            unicodeHex = null;
            inString = false;
            continue;
          }
          if (escaped) {
            escaped = false;
            if (ch === "u") {
              unicodeHex = "";
              continue;
            }
            const decoded = ESCAPES[ch];
            if (decoded === undefined) {
              inString = false;
              continue;
            }
            if (stringMatched) out += decoded;
            else if (stringIsKey) keyBuffer += decoded;
            continue;
          }
          if (ch === "\\") {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
            const parent = stack.at(-1);
            if (stringIsKey && parent?.kind === "object") parent.key = keyBuffer;
            continue;
          }
          if (stringMatched) out += ch;
          else if (stringIsKey) keyBuffer += ch;
          continue;
        }
        switch (ch) {
          case "{":
            stack.push({ kind: "object", key: null });
            break;
          case "[":
            stack.push({ kind: "array" });
            break;
          case "}":
          case "]":
            stack.pop();
            break;
          case ",": {
            const parent = stack.at(-1);
            if (parent?.kind === "object") parent.key = null;
            break;
          }
          case '"': {
            const parent = stack.at(-1);
            inString = true;
            keyBuffer = "";
            if (!parent) {
              stringIsKey = false;
              stringMatched = false;
              break;
            }
            if (parent.kind === "array") {
              // Strings inside arrays are data, not the configured value paths.
              stringIsKey = false;
              stringMatched = false;
            } else if (parent.key === null) {
              stringIsKey = true;
              stringMatched = false;
            } else {
              stringIsKey = false;
              stringMatched = pathMatches(stackPaths(stack));
            }
            break;
          }
          default:
            break;
        }
      }
      return out;
    },
  };
}

/** The configured-path position of the value about to be read, outermost first. */
function stackPaths(stack: readonly Container[]): string[] {
  const path: string[] = [];
  for (const frame of stack) {
    if (frame.kind === "array") path.push("*");
    else if (frame.key !== null) path.push(frame.key);
  }
  return path;
}

/**
 * Product preview gate around a host: extracts presentable text from streamed tool
 * arguments and renumbers the merged text stream so the shared reducer sees one dense
 * delta sequence per attempt revision. Thinking and tool lifecycle frames pass through;
 * raw arguments never leave this layer.
 */
export function withAssistantPreviewHost(base: TurnHost): TurnHost {
  const textPathsByName: Partial<Record<string, readonly (readonly string[])[]>> =
    TOOL_ARGUMENT_TEXTS;
  const names = new Map<string, string>();
  const extractors = new Map<string, ReturnType<typeof createArgumentTextExtractor>>();
  let streamKey = "";
  let textIndex = 0;
  const restart = (key: string): void => {
    if (key === streamKey) return;
    streamKey = key;
    textIndex = 0;
    extractors.clear();
  };
  return {
    ...base,
    emitPreview(turn, frame) {
      if (frame.channel === "tool-args") {
        if (!frame.tool) return;
        const { id } = frame.tool;
        if (frame.tool.name) names.set(id, frame.tool.name);
        const name = names.get(id);
        const paths = name ? textPathsByName[name] : undefined;
        if (!paths) return;
        restart(`${frame.streamEpoch}|${turn.attempt}|${turn.contextRevision}|${frame.revision}`);
        let extractor = extractors.get(id);
        if (!extractor) {
          extractor = createArgumentTextExtractor(paths);
          extractors.set(id, extractor);
        }
        const visible = extractor.push(frame.text);
        if (visible)
          base.emitPreview(turn, { ...frame, channel: "text", text: visible, index: textIndex++ });
        return;
      }
      if (frame.channel === "text") {
        restart(`${frame.streamEpoch}|${turn.attempt}|${turn.contextRevision}|${frame.revision}`);
        base.emitPreview(turn, { ...frame, index: textIndex++ });
        return;
      }
      base.emitPreview(turn, frame);
    },
  };
}
