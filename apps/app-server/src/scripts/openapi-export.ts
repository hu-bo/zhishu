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

function findUnresolvedContractRef(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findUnresolvedContractRef(child);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && !child.startsWith("#/")) return child;
    const found = findUnresolvedContractRef(child);
    if (found) return found;
  }
  return undefined;
}

async function main(): Promise<void> {
  const config = loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "mock",
    DATABASE_URL: "postgresql://postgres@localhost:5432/app",
    LOG_LEVEL: "silent",
  });
  const app = await buildApp(config, { exportMode: true });
  const temporaryOutput = `${output}.${randomUUID()}.tmp`;
  try {
    await app.ready();
    const document = app.swagger() as unknown as {
      openapi?: string;
      paths?: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    const paths = Object.keys(document.paths ?? {});
    // Retirement gate: the deprecated AI/writing protocols must be gone from the source document.
    for (const removed of ["/api/ai/chat", "/api/ai/authoring", "/api/projects"]) {
      if (paths.some((path) => path.startsWith(removed)))
        throw new Error(`OpenAPI document still exposes retired route family ${removed}`);
    }
    for (const required of [
      "/api/ai/qa/capabilities",
      "/api/ai/qa/conversations",
      "/api/ai/writing/capabilities",
      "/api/ai/writing/conversations",
      "/api/qa-sites",
      "/api/public/qa-sites/by-slug/{slug}",
    ]) {
      if (!paths.some((path) => path.startsWith(required)))
        throw new Error(`OpenAPI document is missing the ${required} route family`);
    }
    if (document.openapi !== "3.1.0")
      throw new Error("OpenAPI document must use version 3.1.0 for JSON Schema 2020-12 support");
    const contentSchema = document.components?.schemas?.DocumentContent as
      { properties?: { content?: { items?: { $ref?: string } } } } | undefined;
    if (contentSchema?.properties?.content?.items?.$ref !== "#/components/schemas/DocumentBlock")
      throw new Error("OpenAPI document is missing the shared DocumentContent schema reference");
    if (!document.components?.schemas?.DocumentBlock)
      throw new Error("OpenAPI document is missing the shared DocumentBlock schema");
    for (const name of [
      "DocumentSnapshot",
      "TaskList",
      "Table",
      "TableRow",
      "TableCell",
      "TableHeader",
      "OperationBatch",
      "AssetReference",
      "Anchor",
    ]) {
      if (!document.components?.schemas?.[name])
        throw new Error(`OpenAPI document is missing the shared ${name} schema`);
    }
    const unresolvedRef = findUnresolvedContractRef(document.components?.schemas);
    if (unresolvedRef)
      throw new Error(
        `OpenAPI document contains an unresolved contract reference: ${unresolvedRef}`,
      );
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
