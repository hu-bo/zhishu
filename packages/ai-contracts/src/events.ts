import {
  AiTaskEventSchema,
  AiTaskEventV2Schema,
  type AiTaskEvent,
  type AiTaskEventV2,
} from "./schema.js";
import { invalid, validateSchema, type ValidationResult } from "./validation.js";
import { canonicalJson } from "./canonical-json.js";
export { AiTaskEventSchema, AiTaskEventV2Schema } from "./schema.js";
export type { AiTaskEvent, AiTaskEventV2, AiErrorCode } from "./schema.js";

interface EventValidatorOptions {
  requestId: string;
  maxEventBytes?: number;
  maxStreamBytes?: number;
}
interface EventValidator<E> {
  push(value: unknown): ValidationResult<E>;
  finish(): ValidationResult<true>;
}
export function createAiEventValidator(
  options: EventValidatorOptions & { protocolVersion: 2 },
): EventValidator<AiTaskEventV2>;
export function createAiEventValidator(
  options: EventValidatorOptions & { protocolVersion?: 1 },
): EventValidator<AiTaskEvent>;
export function createAiEventValidator(
  options: EventValidatorOptions & { protocolVersion?: 1 | 2 },
): EventValidator<AiTaskEvent | AiTaskEventV2> {
  const version = options.protocolVersion ?? 1;
  if (version !== 1 && version !== 2) throw new Error("UNSUPPORTED_AI_PROTOCOL");
  let seq = 0,
    bytes = 0,
    terminal = false;
  let kind: "authoring" | "answer" | "chat" | undefined;
  let resultKind: "proposal" | "answer" | "chat" | undefined;
  const schema = version === 2 ? AiTaskEventV2Schema : AiTaskEventSchema;
  const seen = new Map<number, string>();
  return {
    push(value: unknown): ValidationResult<AiTaskEvent | AiTaskEventV2> {
      const checked = validateSchema(schema, value, options.maxEventBytes ?? 32_768);
      if (!checked.success) return checked;
      const event = checked.data,
        serialized = canonicalJson(event);
      if (event.requestId !== options.requestId) return invalid("PROTOCOL_ERROR");
      const previous = seen.get(event.seq);
      if (previous !== undefined)
        return previous === serialized ? checked : invalid("PROTOCOL_ERROR");
      if (
        terminal ||
        event.seq !== seq + 1 ||
        (seq === 0 && event.type !== "started") ||
        (seq > 0 && event.type === "started")
      )
        return invalid("PROTOCOL_ERROR");
      if (event.type === "completed" && (!resultKind || event.payload.resultKind !== resultKind))
        return invalid("PROTOCOL_ERROR");
      if (
        (event.type === "proposal" &&
          (kind !== "authoring" || event.payload.requestId !== options.requestId)) ||
        (event.type === "answer" && kind !== "answer") ||
        (event.type === "chat" && kind !== "chat")
      )
        return invalid("PROTOCOL_ERROR");
      if (resultKind && event.type !== "completed" && event.type !== "failed")
        return invalid("PROTOCOL_ERROR");
      const size = new TextEncoder().encode(serialized).length;
      if (bytes + size > (options.maxStreamBytes ?? 1_048_576)) return invalid("LIMIT_EXCEEDED");
      if (event.type === "started") kind = event.payload.kind;
      if (event.type === "proposal" || event.type === "answer" || event.type === "chat")
        resultKind = event.type;
      terminal = event.type === "completed" || event.type === "failed";
      bytes += size;
      seq = event.seq;
      seen.set(seq, serialized);
      return checked;
    },
    finish(): ValidationResult<true> {
      return terminal ? { success: true, data: true } : invalid("PROTOCOL_ERROR");
    },
  };
}
