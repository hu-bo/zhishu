import { URL } from "node:url";
import console from "node:console";
import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const src = new URL("../src/", import.meta.url);
for (const name of await readdir(src)) {
  const text = await readFile(new URL(name, src), "utf8");
  assert.ok(
    !/from\s+["'](?:fastify|pg|drizzle-orm|@langchain|deepagents|.*apps\/|.*nova-)/.test(text),
    name,
  );
  assert.ok(
    !/\.snapshotEvents\(|\.eventAt\(|\.ownEvents\(/.test(text),
    `Deprecated history read in ${name}`,
  );
  for (const match of text.matchAll(/from\s+["'](@deepseek-ai\/[^"']+)["']/g))
    assert.equal(match[1].split("/").length, 2, `Private deep import in ${name}`);
}
console.log("DSH package boundaries and public kernel imports passed.");
