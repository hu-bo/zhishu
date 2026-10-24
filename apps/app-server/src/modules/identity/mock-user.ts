import type { Principal } from "./identity.types.js";

export type MockPrincipal = Principal & {
  /**
   * Declared role on the auto-created default workspace ("团队知识库").
   * Seeded idempotently on mock login so switching identities produces
   * observable permission differences during development. `undefined`
   * keeps the identity a non-member (falls back to editor/viewer rules).
   * Note: `owner` has no stored member role; it derives from `createdBy`.
   */
  defaultMemberRole?: "admin" | "editor" | "viewer";
};

export const mockUsers: readonly MockPrincipal[] = Object.freeze([
  Object.freeze({
    identityId: "mock-user-001",
    tenantId: "local",
    username: "mock-user",
    displayName: "Mock 测试用户",
    email: "mock-user@example.test",
    globalRoles: Object.freeze(["user"]),
    active: true,
    defaultMemberRole: "admin",
  }),
  Object.freeze({
    identityId: "mock-admin-001",
    tenantId: "local",
    username: "mock-admin",
    displayName: "陈序",
    email: "mock-admin@example.test",
    globalRoles: Object.freeze(["user"]),
    active: true,
    defaultMemberRole: "admin",
  }),
  Object.freeze({
    identityId: "mock-editor-001",
    tenantId: "local",
    username: "mock-editor",
    displayName: "江予",
    email: "mock-editor@example.test",
    globalRoles: Object.freeze(["user"]),
    active: true,
    defaultMemberRole: "editor",
  }),
  Object.freeze({
    identityId: "mock-viewer-001",
    tenantId: "local",
    username: "mock-viewer",
    displayName: "苏棠",
    email: "mock-viewer@example.test",
    globalRoles: Object.freeze(["user"]),
    active: true,
    defaultMemberRole: "viewer",
  }),
  Object.freeze({
    identityId: "mock-guest-001",
    tenantId: "local",
    username: "mock-guest",
    displayName: "访客",
    email: "mock-guest@example.test",
    globalRoles: Object.freeze(["user"]),
    active: true,
  }),
]);

export const mockUser: MockPrincipal = mockUsers[0];

export function getMockUser(userId: string | undefined): MockPrincipal | undefined {
  if (!userId) return mockUser;
  return mockUsers.find((user) => user.identityId === userId);
}
