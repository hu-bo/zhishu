import type { DocumentContent } from "./schema.js";

export interface ContentMigration {
  readonly fromSchemaVersion: number;
  readonly toSchemaVersion: number;
  migrate(content: unknown): unknown;
}

export interface ContentMigrationStepReport {
  fromSchemaVersion: number;
  toSchemaVersion: number;
}

export interface ContentMigrationReport {
  status: "unchanged" | "migrated" | "failed";
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  steps: ContentMigrationStepReport[];
  error?: {
    code:
      | "invalid-range"
      | "invalid-source"
      | "missing-step"
      | "invalid-step"
      | "invalid-output"
      | "migration-failed";
    fromSchemaVersion: number;
    issues?: Array<{ path: string; message: string }>;
  };
}

export type ContentMigrationResult<TContent = DocumentContent> =
  | { success: true; content: TContent; report: ContentMigrationReport }
  | { success: false; original: unknown; report: ContentMigrationReport };

/**
 * Migrations are explicit, deterministic steps. Implementations must not mutate their input;
 * callers retain the original snapshot if a later validation or storage step fails.
 */
export type ContentMigrationExecutor<TContent = DocumentContent> = (
  content: unknown,
  sourceSchemaVersion: number,
  targetSchemaVersion: number,
) => ContentMigrationResult<TContent>;

export interface ContentMigrationTarget<TContent = DocumentContent> {
  schemaVersion: number;
  validate(
    content: unknown,
  ):
    | { success: true; data: TContent }
    | { success: false; issues: readonly { path: string; message: string }[] };
}

/**
 * Creates an executor for an immutable migration registry. Each source version may have one
 * outgoing step; a migration can skip versions when that transition is explicitly defined.
 */
export function createContentMigrationExecutor<TContent = DocumentContent>(
  migrations: readonly ContentMigration[],
  target: ContentMigrationTarget<TContent>,
): ContentMigrationExecutor<TContent> {
  const stepsBySource = new Map<number, ContentMigration>();
  if (!Number.isSafeInteger(target.schemaVersion) || target.schemaVersion < 1)
    throw new TypeError("The target schema version must be a positive safe integer.");

  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.fromSchemaVersion) ||
      !Number.isSafeInteger(migration.toSchemaVersion) ||
      migration.fromSchemaVersion < 1 ||
      migration.toSchemaVersion <= migration.fromSchemaVersion ||
      stepsBySource.has(migration.fromSchemaVersion)
    ) {
      throw new TypeError("Migration registry contains an invalid or ambiguous step.");
    }
    stepsBySource.set(migration.fromSchemaVersion, migration);
  }

  return (original, sourceSchemaVersion, targetSchemaVersion) => {
    const steps: ContentMigrationStepReport[] = [];
    const baseReport = {
      sourceSchemaVersion,
      targetSchemaVersion,
      steps,
    };
    const fail = (
      code: NonNullable<ContentMigrationReport["error"]>["code"],
      fromSchemaVersion: number,
      issues?: Array<{ path: string; message: string }>,
    ): ContentMigrationResult<TContent> => ({
      success: false,
      original,
      report: {
        ...baseReport,
        status: "failed",
        error: { code, fromSchemaVersion, ...(issues ? { issues } : {}) },
      },
    });

    if (
      !Number.isSafeInteger(sourceSchemaVersion) ||
      !Number.isSafeInteger(targetSchemaVersion) ||
      sourceSchemaVersion < 1 ||
      targetSchemaVersion < sourceSchemaVersion ||
      targetSchemaVersion !== target.schemaVersion
    ) {
      return fail("invalid-range", sourceSchemaVersion);
    }

    let working: unknown;
    try {
      working = structuredClone(original);
    } catch {
      return fail("invalid-source", sourceSchemaVersion);
    }

    let currentVersion = sourceSchemaVersion;
    while (currentVersion < targetSchemaVersion) {
      const migration = stepsBySource.get(currentVersion);
      if (!migration || migration.toSchemaVersion > targetSchemaVersion)
        return fail("missing-step", currentVersion);

      try {
        working = migration.migrate(working);
      } catch {
        return fail("migration-failed", currentVersion);
      }
      steps.push({
        fromSchemaVersion: migration.fromSchemaVersion,
        toSchemaVersion: migration.toSchemaVersion,
      });
      currentVersion = migration.toSchemaVersion;
    }

    let validated:
      | { success: true; data: TContent }
      | { success: false; issues: readonly { path: string; message: string }[] };
    try {
      validated = target.validate(working);
    } catch {
      return fail("invalid-output", currentVersion);
    }
    if (!validated.success) {
      return fail(
        "invalid-output",
        currentVersion,
        validated.issues.map(({ path, message }) => ({ path, message })),
      );
    }

    return {
      success: true,
      content: validated.data,
      report: {
        ...baseReport,
        status: currentVersion === sourceSchemaVersion ? "unchanged" : "migrated",
      },
    };
  };
}
