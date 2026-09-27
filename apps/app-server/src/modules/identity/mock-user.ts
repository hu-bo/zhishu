import type { Principal } from "./identity.types.js";

export const mockUser: Principal = Object.freeze({
  identityId: "mock-user-001",
  tenantId: "local",
  username: "mock-user",
  displayName: "Mock 测试用户",
  email: "mock-user@example.test",
  globalRoles: Object.freeze(["user"]),
  active: true,
});
