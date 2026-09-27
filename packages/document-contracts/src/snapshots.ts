import { Value } from "@sinclair/typebox/value";
import { DocumentBlockSchema, DocumentContentSchema, DocumentSnapshotSchema } from "./schema.js";
import type { DocumentSnapshot, ExtensionRequirement } from "./schema.js";
import { validateDocumentContent } from "./validation.js";

export interface SnapshotIssue {
  path: string;
  message: string;
}

export type SnapshotValidationResult =
  { success: true; data: DocumentSnapshot } | { success: false; issues: SnapshotIssue[] };

export function validateDocumentSnapshot(input: unknown): SnapshotValidationResult {
  const references = [DocumentContentSchema, DocumentBlockSchema];
  if (!Value.Check(DocumentSnapshotSchema, references, input)) {
    return {
      success: false,
      issues: [...Value.Errors(DocumentSnapshotSchema, references, input)].map((error) => ({
        path: error.path || "$",
        message: error.message,
      })),
    };
  }
  const snapshot = input as DocumentSnapshot;
  const content = validateDocumentContent(snapshot.content);
  if (!content.success)
    return {
      success: false,
      issues: content.issues.map(({ path, message }) => ({
        path: `$.content${path.slice(1)}`,
        message,
      })),
    };
  return { success: true, data: snapshot };
}

export interface SnapshotCompatibilityOptions {
  schemaVersions: readonly number[];
  extensions: Readonly<Record<string, readonly string[]>>;
}

export interface DocumentCompatibilityInput {
  schemaVersion: number;
  extensions: readonly ExtensionRequirement[];
}

export interface SnapshotCompatibilityIssue {
  code: "unsupported-schema" | "unsupported-extension";
  name: string;
  required: boolean;
}

export interface SnapshotCompatibility {
  readable: boolean;
  writable: boolean;
  issues: SnapshotCompatibilityIssue[];
}

export function checkSnapshotCompatibility(
  snapshot: DocumentSnapshot,
  supported: SnapshotCompatibilityOptions,
): SnapshotCompatibility {
  return checkDocumentCompatibility(snapshot, supported);
}

export function checkDocumentCompatibility(
  document: DocumentCompatibilityInput,
  supported: SnapshotCompatibilityOptions,
): SnapshotCompatibility {
  const issues: SnapshotCompatibilityIssue[] = [];
  if (!supported.schemaVersions.includes(document.schemaVersion)) {
    issues.push({
      code: "unsupported-schema",
      name: String(document.schemaVersion),
      required: true,
    });
  }

  for (const requirement of document.extensions) {
    if (!supported.extensions[requirement.name]?.includes(requirement.version)) {
      issues.push({
        code: "unsupported-extension",
        name: `${requirement.name}@${requirement.version}`,
        required: requirement.required,
      });
    }
  }

  const readable = !issues.some((entry) => entry.required);
  return {
    readable,
    writable: readable && issues.length === 0,
    issues,
  };
}
