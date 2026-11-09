import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceSchema, updateWorkspaceSchema } from "./workspace.schema.js";
import { workspaceRole } from "../authorization/permissions.js";

test("personal workspace organization requires its explicit owner, regardless of membership or creator fallback", () => {
  const workspace = {
    kind: "personal",
    createdBy: "creator",
    ownerIdentityId: "owner",
    personalOwnerId: "owner",
  } as const;
  assert.equal(workspaceRole(workspace, "owner"), "owner");
  for (const identityId of ["creator", "other"])
    for (const memberRole of [undefined, "viewer", "editor", "admin"] as const)
      assert.equal(workspaceRole(workspace, identityId, memberRole), "viewer");
  assert.equal(
    workspaceRole({ ...workspace, personalOwnerId: null }, "creator", "admin"),
    "viewer",
  );
  assert.equal(
    workspaceRole({ ...workspace, createdBy: "system", ownerIdentityId: null }, "other", "admin"),
    "viewer",
  );
});

test("team and legacy spaces preserve current organizational roles without claiming personal ownership", () => {
  for (const kind of ["team", "unclassified"] as const) {
    const workspace = { kind, createdBy: "owner", ownerIdentityId: "owner", personalOwnerId: null };
    assert.equal(workspaceRole(workspace, "owner"), "owner");
    assert.equal(workspaceRole(workspace, "other"), "viewer");
    assert.equal(workspaceRole(workspace, "other", "admin"), "admin");
    assert.equal(workspaceRole(workspace, "other", "editor"), "editor");
    assert.equal(
      workspaceRole({ ...workspace, createdBy: "system", ownerIdentityId: null }, "other"),
      "viewer",
    );
    assert.equal(
      workspaceRole(
        { ...workspace, createdBy: "system", ownerIdentityId: null },
        "other",
        "viewer",
      ),
      "viewer",
    );
  }
});

test("creation assigns a declared kind while ownership and legacy classification stay server controlled", () => {
  assert.equal(createWorkspaceSchema.parse({ name: "团队" }).kind, "team");
  assert.equal(createWorkspaceSchema.parse({ name: "个人", kind: "personal" }).kind, "personal");
  for (const input of [
    { name: "旧空间", kind: "unclassified" },
    { name: "伪造", kind: "personal", personalOwnerId: "other" },
    { name: "伪造", kind: "personal", createdBy: "other" },
  ])
    assert.equal(createWorkspaceSchema.safeParse(input).success, false);
  assert.deepEqual(updateWorkspaceSchema.parse({ name: "新名称" }), {
    name: "新名称",
    description: "",
  });
  for (const field of [{ kind: "personal" }, { kind: "team" }, { personalOwnerId: "other" }])
    assert.equal(updateWorkspaceSchema.safeParse({ name: "修改", ...field }).success, false);
});
