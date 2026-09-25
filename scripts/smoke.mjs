import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { buildApp } from "../apps/server/dist/src/app.js";
import { loadConfig } from "../apps/server/dist/src/config.js";

// Use a disposable database: this check creates and removes a project.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to a disposable database");
const app = await buildApp(loadConfig({ ...process.env, LOG_LEVEL: "silent" }));
let id;
try {
  await app.ready();
  for (const url of ["/health/live", "/health/ready", "/documentation/json"]) {
    assert.equal((await app.inject({ url })).statusCode, 200, url);
  }
  const invalid = await app.inject({
    method: "POST",
    url: "/api/projects/",
    payload: { name: " " },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, "VALIDATION_ERROR");
  const malformed = await app.inject({
    method: "POST",
    url: "/api/projects/",
    headers: { "content-type": "application/json" },
    payload: "{",
  });
  assert.equal(malformed.statusCode, 400);
  const created = await app.inject({
    method: "POST",
    url: "/api/projects/",
    payload: { name: " Review project " },
  });
  assert.equal(created.statusCode, 201);
  id = created.json().id;
  assert.equal(created.json().name, "Review project");
  assert.equal(typeof created.json().createdAt, "string");
  assert.equal((await app.inject({ url: `/api/projects/${id}` })).statusCode, 200);
  const list = await app.inject({ url: "/api/projects/?limit=100" });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().items.some((item) => item.id === id));
  assert.equal((await app.inject({ url: "/api/projects/?limit=101" })).statusCode, 400);
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: {} })).statusCode,
    400,
  );
  const updated = await app.inject({
    method: "PATCH",
    url: `/api/projects/${id}`,
    payload: { name: "Updated" },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().name, "Updated");
  const removed = await app.inject({ method: "DELETE", url: `/api/projects/${id}` });
  assert.equal(removed.statusCode, 204);
  assert.equal(removed.body, "");
  const missing = await app.inject({ url: `/api/projects/${id}` });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "NOT_FOUND");
  id = undefined;
  assert.equal((await app.inject({ url: "/missing" })).json().code, "NOT_FOUND");
  console.log("Smoke passed: health, OpenAPI, CRUD, validation, protocol errors, domain errors.");
} finally {
  try {
    if (id) await app.inject({ method: "DELETE", url: `/api/projects/${id}` });
  } finally {
    await app.close();
  }
}
