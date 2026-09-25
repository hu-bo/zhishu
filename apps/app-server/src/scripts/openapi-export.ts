import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { serverRoot } from "../paths.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const packageRoot = serverRoot;
const output = process.argv[2]
  ? isAbsolute(process.argv[2])
    ? process.argv[2]
    : resolve(packageRoot, process.argv[2])
  : resolve(packageRoot, "openapi.json");

async function main(): Promise<void> {
  const config = loadConfig({
    DATABASE_URL: "postgresql://postgres@localhost:5432/app",
    LOG_LEVEL: "silent",
  });
  const app = await buildApp(config, { exportMode: true });
  const temporaryOutput = `${output}.${randomUUID()}.tmp`;
  try {
    await app.ready();
    const document = app.swagger();
    if (!document.paths?.["/api/projects/"])
      throw new Error("OpenAPI document is missing project routes");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(temporaryOutput, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporaryOutput, output);
  } finally {
    try {
      await app.close();
    } finally {
      await rm(temporaryOutput, { force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
