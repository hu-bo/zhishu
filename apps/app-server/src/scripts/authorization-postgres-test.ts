import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const url = process.env.AUTHORIZATION_TEST_DATABASE_URL;
if (!url || !/^\/zhishu_permission_test_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error(
    "Set AUTHORIZATION_TEST_DATABASE_URL to a fresh, isolated local zhishu_permission_test_* database. The suite applies migrations.",
  );
const require = createRequire(import.meta.url);
const child = spawn(
  process.execPath,
  [
    require.resolve("tsx/cli"),
    "--test",
    "src/modules/authorization/authorization.test.ts",
    "src/modules/workspaces/workspace.test.ts",
  ],
  { stdio: "inherit", env: process.env, windowsHide: true },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
