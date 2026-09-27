import { Value } from "@sinclair/typebox/value";
import { CollaborationPresenceSchema } from "./schema.js";
import type { CollaborationPresence } from "./schema.js";

const maxPresenceBytes = 2_048;

export type CollaborationPresenceValidationResult =
  | { success: true; data: CollaborationPresence }
  | { success: false; issues: Array<{ path: string; message: string }> };

export function validateCollaborationPresence(
  input: unknown,
): CollaborationPresenceValidationResult {
  try {
    if (!Value.Check(CollaborationPresenceSchema, [], input)) {
      return {
        success: false,
        issues: [...Value.Errors(CollaborationPresenceSchema, [], input)].map((error) => ({
          path: error.path || "$",
          message: error.message,
        })),
      };
    }
    const presence = input as CollaborationPresence;
    if (presence.displayName.trim().length === 0) {
      return {
        success: false,
        issues: [{ path: "$.displayName", message: "Display name cannot be blank." }],
      };
    }
    const byteLength = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    if (byteLength > maxPresenceBytes) {
      return {
        success: false,
        issues: [{ path: "$", message: `Presence exceeds ${maxPresenceBytes} bytes.` }],
      };
    }
    return { success: true, data: presence };
  } catch {
    return { success: false, issues: [{ path: "$", message: "Presence must be JSON data." }] };
  }
}
