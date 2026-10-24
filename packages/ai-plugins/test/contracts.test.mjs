import test from "node:test";
import assert from "node:assert/strict";
import { isImageJob, manifests } from "../dist/contracts.js";
test("image readiness requires durable resource metadata; unknown outcomes remain explicit", () => {
  assert.equal(manifests.length, 3);
  assert.ok(isImageJob({ id: "external-action", status: "unknown" }));
  assert.ok(!isImageJob({ id: "external-action", status: "ready", assets: [] }));
  assert.ok(
    !isImageJob({
      id: "external-action",
      status: "ready",
      assets: [{ assetId: "private-image", mime: "text/html", width: 1024, height: 1024 }],
    }),
  );
  assert.ok(
    isImageJob({
      id: "external-action",
      status: "ready",
      assets: [{ assetId: "private-image", mime: "image/png", width: 1024, height: 1024 }],
    }),
  );
});
