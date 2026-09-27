export const documentPermissionActions = [
  "read",
  "write",
  "comment",
  "share",
  "export",
  "ai",
] as const;
export type DocumentPermissionAction = (typeof documentPermissionActions)[number];
