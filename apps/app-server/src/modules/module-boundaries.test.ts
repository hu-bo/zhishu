import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const modules = fileURLToPath(new URL(".", import.meta.url));
const owner = (file: string) => relative(modules, file).split(/[\\/]/)[0];

function collectImports(file: string, includeTypeOnly: boolean): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  return source.statements.flatMap((node) => {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return [];
    const module = node.moduleSpecifier;
    if (!module || !ts.isStringLiteral(module) || !module.text.startsWith(".")) return [];
    if (!includeTypeOnly) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.isTypeOnly) return [];
        if (
          clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((binding) => binding.isTypeOnly)
        )
          return [];
      } else if (
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((binding) => binding.isTypeOnly))
      )
        return [];
    }
    return [resolve(dirname(file), module.text.replace(/\.js$/, ".ts"))];
  });
}

function runtimeImports(file: string): string[] {
  return collectImports(file, false);
}

test("workspace, catalog and authorization policy modules remain independent of document orchestration", () => {
  for (const module of ["workspaces", "catalogs", "authorization"])
    for (const file of readdirSync(join(modules, module))) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      for (const dependency of runtimeImports(join(modules, module, file)))
        assert.ok(
          !["documents", "knowledge"].includes(owner(dependency)),
          `${module}/${file} must not depend on ${relative(modules, dependency)}`,
        );
    }
});

test("new module entry points and the authorization domain API have no transitive runtime file cycles", () => {
  const complete = new Set<string>();
  function visit(file: string, ancestors: string[]) {
    assert.ok(
      !ancestors.includes(file),
      `Runtime cycle: ${[...ancestors, file].map((path) => relative(modules, path)).join(" -> ")}`,
    );
    if (complete.has(file)) return;
    for (const dependency of runtimeImports(file)) visit(dependency, [...ancestors, file]);
    complete.add(file);
  }
  for (const entry of [
    "workspaces/index.ts",
    "catalogs/index.ts",
    "knowledge/index.ts",
    "authorization/permissions.ts",
  ])
    visit(join(modules, entry), []);
});

test("AI modules keep one direction: shared store below, purposes and sites above, no cross-engine imports", () => {
  const forbidden: Record<string, string[]> = {
    // The shared product store must stay engine-agnostic.
    ai: ["qa", "writing", "qa-sites"],
    // The two purposes never import each other's internals; sites own their public layer.
    qa: ["writing", "qa-sites"],
    writing: ["qa", "qa-sites"],
    "qa-sites": ["writing"],
    // Business documents never reverse-import the public site module.
    documents: ["qa-sites"],
    knowledge: ["qa-sites"],
    catalogs: ["qa-sites"],
  };
  for (const [module, banned] of Object.entries(forbidden)) {
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(modules, dir), { withFileTypes: true })) {
        const path = join(modules, dir, entry.name);
        if (entry.isDirectory()) {
          walk(join(dir, entry.name));
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        for (const dependency of runtimeImports(path))
          assert.ok(
            !banned.includes(owner(dependency)),
            `${relative(modules, path)} must not depend on ${relative(modules, dependency)}`,
          );
      }
    };
    if (existsSync(join(modules, module))) walk(module);
  }
});

test("retired AI engines, legacy product protocols and the template module are gone from the server", () => {
  const serverRoot = resolve(modules, "../..");
  const sources = readdirSync(join(serverRoot, "src/modules"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const retired of ["writing-chat", "projects"])
    assert.ok(!sources.includes(retired), `module ${retired} must be retired`);
  const rootManifest = JSON.parse(
    readFileSync(resolve(serverRoot, "../../package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  for (const retired of ["@zhishu/ai-runtime", "@zhishu/ai-plugins", "@zhishu/dsh-agent"])
    assert.ok(!(rootManifest.dependencies ?? {})[retired], `${retired} must not be a dependency`);
  // Database schema may only import pure contracts and its own files — type imports included.
  for (const file of readdirSync(resolve(serverRoot, "database/schema"))) {
    if (!file.endsWith(".table.ts")) continue;
    for (const dependency of collectImports(resolve(serverRoot, "database/schema", file), true))
      assert.ok(
        !relative(serverRoot, dependency).startsWith("src") && !dependency.includes("node_modules"),
        `database/schema/${file} must not import server modules or engine packages`,
      );
  }
});

test("the DSH kernel stays behind @zhishu packages: app-server never touches @deepseek-ai", () => {
  const serverRoot = resolve(modules, "../..");
  const manifest = JSON.parse(readFileSync(resolve(serverRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
    assert.ok(
      !dep.startsWith("@deepseek-ai/"),
      `${dep} must not be a direct app-server dependency`,
    );
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "dist") walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
        assert.ok(
          !/["']@deepseek-ai\//.test(readFileSync(path, "utf8")),
          `${relative(serverRoot, path)} must take kernel types and helpers from @zhishu/ai-writing/kernel`,
        );
    }
  };
  for (const dir of ["src", "database"]) walk(join(serverRoot, dir));
});
