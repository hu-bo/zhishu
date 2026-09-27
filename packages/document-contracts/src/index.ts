export {
  DocumentBlockSchema,
  DocumentContentSchema,
  DocumentSnapshotSchema,
  CollaborationPresenceSchema,
  AssetReferenceSchema,
  AnchorSchema,
  ExtensionRequirementSchema,
  OperationBatchSchema,
  OperationSchema,
  documentContractJsonSchemas,
} from "./schema.js";
export type {
  DocumentBlock,
  DocumentContent,
  DocumentOperation,
  DocumentSnapshot,
  AssetReference,
  Anchor,
  ExtensionRequirement,
  CollaborationPresence,
  OperationBatch,
} from "./schema.js";
export {
  checkDocumentCompatibility,
  checkSnapshotCompatibility,
  validateDocumentSnapshot,
} from "./snapshots.js";
export type {
  DocumentCompatibilityInput,
  SnapshotCompatibility,
  SnapshotCompatibilityIssue,
  SnapshotCompatibilityOptions,
  SnapshotIssue,
  SnapshotValidationResult,
} from "./snapshots.js";
export {
  cloneBlockWithFreshIds,
  cloneContentWithFreshBlockIds,
  createBlockId,
  repairDuplicateBlockIds,
} from "./identity.js";
export { applyOperationBatch } from "./operations.js";
export { checkAnchorTarget } from "./anchors.js";
export type { AnchorTargetContext, AnchorTargetStatus } from "./anchors.js";
export { validateCollaborationPresence } from "./presence.js";
export type { CollaborationPresenceValidationResult } from "./presence.js";
export type {
  ApplyOperationContext,
  ApplyOperationResult,
  OperationError,
  OperationErrorCode,
} from "./operations.js";
export type {
  ContentMigration,
  ContentMigrationExecutor,
  ContentMigrationReport,
  ContentMigrationResult,
  ContentMigrationStepReport,
  ContentMigrationTarget,
} from "./migration.js";
export { createContentMigrationExecutor } from "./migration.js";
export {
  assertDocumentContent,
  normalizeDocumentContent,
  validateDocumentContent,
} from "./validation.js";
export type {
  ContentIssue,
  ContentIssueCode,
  ContentLimits,
  ContentValidationResult,
} from "./validation.js";
