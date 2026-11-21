import assert from "node:assert/strict";
import test from "node:test";
import { manifests, isImageJob } from "../dist/contracts.js";
import { loadSkillInstruction, skillDefinitions } from "../dist/skills.js";

test("manifests cover the five composable plugins", () => {
  assert.deepEqual(
    manifests.map((m) => m.id),
    ["scope", "rag", "research", "writing", "image"],
  );
});

test("image job guard accepts real states and rejects fabricated success", () => {
  assert.equal(isImageJob({ id: "j", status: "pending" }), true);
  assert.equal(isImageJob({ id: "j", status: "unknown" }), true);
  assert.equal(
    isImageJob({
      id: "j",
      status: "ready",
      assets: [{ assetId: "a", mime: "image/png", width: 1024, height: 1024 }],
    }),
    true,
  );
  assert.equal(isImageJob({ id: "j", status: "ready" }), false);
  assert.equal(isImageJob({ id: "j", status: "done" }), false);
});

test("skill resources ship with the package and load by id", async () => {
  assert.equal(skillDefinitions.length, 5);
  const writing = await loadSkillInstruction("writing");
  assert.ok(writing.includes("创建草稿"));
  const rag = await loadSkillInstruction("rag-answer");
  assert.ok(rag.includes("insufficient-evidence"));
  await assert.rejects(loadSkillInstruction("legacy-authoring"), /UNKNOWN_SKILL/);
});
