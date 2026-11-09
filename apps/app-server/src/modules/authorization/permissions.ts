// Public domain API. Keep HTTP registration and service composition out of this entry point.
export { catalogActionSql, spaceActionSql, loadPolicyOverrides } from "./access.js";
export {
  policyEnforcer,
  effectiveActions,
  defaultActions,
  accessRoles,
  permissionActions,
} from "./policy.js";
export type { AccessRole, PermissionAction } from "./policy.js";
export {
  documentAccessModes,
  documentActionSql,
  documentRolesSql,
  documentGrantActiveSql,
  requireDocumentManager,
  hasDocumentPermission,
  requireWorkspaceDocumentManagers,
} from "./document-access.js";
export { workspaceAccess, workspaceRole, requireWorkspaceOrganizer } from "./workspace-access.js";
export { SessionInvalidator } from "./session-invalidation.js";
export type { DocumentAccessMode } from "./document-access.js";
