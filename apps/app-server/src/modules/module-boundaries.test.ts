import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const modules = fileURLToPath(new URL(".", import.meta.url));
const owner = (file: string) => relative(modules, file).split(/[\\/]/)[0];

function runtimeImports(file: string): string[] {
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
    return [resolve(dirname(file), module.text.replace(/\.js$/, ".ts"))];
  });
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
