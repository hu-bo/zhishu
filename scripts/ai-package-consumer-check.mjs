import console from "node:console";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const workspacePackages = [
  "document-contracts",
  "ai-contracts",
  "chat-contracts",
  "chat-ui",
  "ai-qa",
  "ai-writing",
  "rag",
];

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) resolveRun(stdout);
      else
        rejectRun(
          new Error(`${command} ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`),
        );
    });
  });
}

const workspace = await mkdtemp(join(tmpdir(), "zhishu-ai-consumers-"));
// Multiple plain --filter args avoid regex pipes, which cmd.exe would split as pipelines.
const packageFilters = workspacePackages.flatMap((name) => ["--filter", `@zhishu/${name}`]);
const grepFiles = (pattern) => {
  const re = new RegExp(pattern);
  const extensions = new Set([".ts", ".tsx", ".mjs", ".json"]);
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.has(extname(full))) {
        if (re.test(readFileSync(full, "utf8")))
          hits.push(relative(repoRoot, full).replaceAll("\\", "/"));
      }
    }
  };
  for (const root of [
    "apps/app-server/src",
    "apps/app-server/database/schema",
    "apps/app-web/src",
    "packages",
    "examples",
    "scripts",
  ]) {
    const absolute = join(repoRoot, root);
    if (existsSync(absolute)) walk(absolute);
  }
  return hits;
};
try {
  await run("pnpm", ["-r", ...packageFilters, "build"]);
  for (const name of workspacePackages)
    await run("pnpm", ["--dir", `packages/${name}`, "pack", "--pack-destination", workspace]);
  const archive = (name) => join(workspace, `zhishu-${name}-0.1.0.tgz`);

  // 1. Official-kernel standalone consumption: run the writing example from packed @zhishu/ai-writing only.
  await run("pnpm", [
    "--dir",
    "examples/writing-consumer",
    "pack",
    "--pack-destination",
    workspace,
  ]);
  const exampleArchive = join(workspace, "zhishu-writing-consumer-example-0.0.0.tgz");
  if (!existsSync(exampleArchive)) throw new Error(`missing example archive ${exampleArchive}`);
  const writingExample = join(workspace, "writing-consumer");
  await run("tar", ["-xzf", exampleArchive, "-C", workspace]);
  await rm(writingExample, { recursive: true, force: true });
  renameSync(join(workspace, "package"), writingExample);
  const examplePkgPath = join(writingExample, "package.json");
  const examplePkg = JSON.parse(readFileSync(examplePkgPath, "utf8"));
  // Packed tarballs rewrite workspace protocols to versions; pin every transitive
  // @zhishu dependency back to the local archives so resolution never hits a registry.
  const localOverrides = Object.fromEntries(
    workspacePackages.map((name) => [`@zhishu/${name}`, `file:${archive(name)}`]),
  );
  examplePkg.pnpm = { ...examplePkg.pnpm, overrides: localOverrides };
  examplePkg.overrides = localOverrides;
  examplePkg.dependencies = {
    ...examplePkg.dependencies,
    "@zhishu/ai-writing": `file:${archive("ai-writing")}`,
    "@zhishu/ai-contracts": `file:${archive("ai-contracts")}`,
    "@zhishu/document-contracts": `file:${archive("document-contracts")}`,
  };
  writeFileSync(examplePkgPath, `${JSON.stringify(examplePkg, null, 2)}\n`);
  await run("pnpm", ["install", "--ignore-scripts"], { cwd: writingExample });
  const exampleOutput = await run("node", ["index.mjs"], { cwd: writingExample });
  if (!exampleOutput.includes("官方 Agent Loop"))
    throw new Error("writing example did not reach the official kernel");

  // 2. Public declarations and isolated React consumption through published exports only.
  const isolated = join(workspace, "isolated-ai-consumers");
  mkdirSync(isolated, { recursive: true });
  writeFileSync(
    join(isolated, "package.json"),
    JSON.stringify(
      {
        name: "isolated-ai-consumers",
        private: true,
        type: "module",
        dependencies: {
          ...Object.fromEntries(
            workspacePackages.map((name) => [`@zhishu/${name}`, `file:${archive(name)}`]),
          ),
          react: "19.2.8",
          "react-dom": "19.2.8",
        },
        pnpm: {
          overrides: Object.fromEntries(
            workspacePackages.map((name) => [`@zhishu/${name}`, `file:${archive(name)}`]),
          ),
        },
        overrides: Object.fromEntries(
          workspacePackages.map((name) => [`@zhishu/${name}`, `file:${archive(name)}`]),
        ),
      },
      null,
      2,
    ),
  );
  await run("pnpm", ["install", "--ignore-scripts"], { cwd: isolated });
  const consumerSource = `
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import {
  DEFAULT_GENERATION_LIMITS,
  validateEvidenceBundle,
  citationsMatchEvidence,
  validateWritingRequest,
  validateWritingProposalPayload,
  canonicalJson,
} from "@zhishu/ai-contracts";
import { hashContent } from "@zhishu/ai-contracts/hash";
import { applyAiEvent, applyPreviewFrame, isSubmitMessage, isStreamFrame } from "@zhishu/chat-contracts";
import { Chat, Composer } from "@zhishu/chat-ui";
import { runQaAnswerFlow, QaFlowError } from "@zhishu/ai-qa";
import {
  createWritingRuntime,
  deterministicNativeSessionId,
  compileProposal,
  installWriting,
  installPlatformResearch,
  installWebResearch,
  installImage,
} from "@zhishu/ai-writing";
import { manifests as writingManifests, isImageJob } from "@zhishu/ai-writing/contracts";
import { loadSkillInstruction, skillDefinitions, retrievalToolSchemas } from "@zhishu/rag";

const checks = [];
if (typeof runQaAnswerFlow !== "function") throw new Error("qa flow missing");
if (typeof createWritingRuntime !== "function") throw new Error("writing runtime missing");
if (typeof compileProposal !== "function") throw new Error("pure compiler missing");
if (typeof installWriting !== "function" || typeof installWebResearch !== "function" || typeof installImage !== "function")
  throw new Error("writing tools missing");
if (typeof installPlatformResearch !== "function") throw new Error("platform tools missing");
if (deterministicNativeSessionId("ai_x", 1) === deterministicNativeSessionId("ai_x", 2))
  throw new Error("native session ids must isolate context revisions");
if (!QaFlowError) throw new Error("qa flow error missing");
if (!DEFAULT_GENERATION_LIMITS.webSearchCallsPerRun) throw new Error("web research budgets missing");
const bundle = {
  freshness: "current",
  sources: [
    {
      sourceKind: "document",
      sourceId: "doc_1",
      snapshotId: "snap_1",
      title: "T",
      workspaceId: "ws_1",
      documentId: "doc_1",
      generationId: "gen_1",
      durableSeq: "1",
      metadataRevision: "1",
      indexVersion: "iv_1",
    },
  ],
  items: [
    {
      evidenceId: "ev_1",
      sourceId: "doc_1",
      snapshotId: "snap_1",
      locator: { kind: "block", blockId: "block_a", start: 0, end: 2 },
      text: "中文",
    },
  ],
};
if (!validateEvidenceBundle(bundle).success) throw new Error("evidence contract broken");
if (
  !citationsMatchEvidence(
    [
      {
        citationId: "c1",
        evidenceArtifactId: "art_1",
        evidenceId: "ev_1",
        locator: { kind: "block", blockId: "block_a", start: 0, end: 2 },
        quote: "中文",
      },
    ],
    bundle,
    "art_1",
  )
)
  throw new Error("citation contract broken");
if (!hashContent({ a: 1 }).startsWith("sha256:")) throw new Error("hash contract broken");
if (typeof validateWritingRequest !== "function" || typeof validateWritingProposalPayload !== "function")
  throw new Error("writing validators missing");
if (typeof applyAiEvent !== "function" || typeof applyPreviewFrame !== "function")
  throw new Error("shared reducers missing");
if (
  !isSubmitMessage({
    purpose: "qa",
    clientMessageId: "c",
    idempotencyKey: "i",
    text: "问",
    expectedContextRevision: 1,
  })
)
  throw new Error("submit contract broken");
if (isStreamFrame({ type: "nope" })) throw new Error("frame guard broken");
const html = renderToString(
  createElement(Chat, {
    messages: [{ id: "1", role: "user", parts: [{ id: "p", kind: "text", text: "独立安装" }] }],
    composer: createElement(Composer, { value: "", onValueChange: () => {}, onSubmit: () => {} }),
  }),
);
if (!html.includes("独立安装")) throw new Error("chat-ui SSR failed");
if (writingManifests.length !== 4 || !isImageJob({ id: "j", status: "pending" }))
  throw new Error("writing contracts broken");
const ragSkill = await loadSkillInstruction("rag");
if (!ragSkill.includes("知书")) throw new Error("rag skill resource unreadable");
if (skillDefinitions.length !== 2) throw new Error("skill definitions broken");
if (!retrievalToolSchemas.searchPlatform.name) throw new Error("tool schemas broken");
if (canonicalJson({ b: 1, a: [2] }) !== '{"a":[2],"b":1}') throw new Error("canonical json broken");
checks.push("contracts", "qa-flow", "writing-runtime", "chat-ui", "skill-resources");
console.log(JSON.stringify(checks));
`;
  writeFileSync(join(isolated, "consumer.mjs"), consumerSource);
  await run("node", ["consumer.mjs"], { cwd: isolated });

  // 3. Legacy retirement gate (docs §15.1): production code must not reference retired engines.
  const scanPatterns = [
    ["retired package imports", 'from "@zhishu/(ai-runtime|ai-plugins|dsh-agent)"'],
    [
      "legacy protocols",
      "AiTaskEvent|legacy-authoring|ChatRecord|ChatStore|previousRequestIds|inputMessageId",
    ],
    ["retired routes", '"/api/ai/chat|"/api/ai/authoring|prefix: "/writing"|/api/writing/'],
    ["retired db shapes", 'engine\\?:|pgTable\\(\\s*"projects"|writing_events'],
  ];
  for (const [label, pattern] of scanPatterns) {
    const offenders = grepFiles(pattern).filter(
      (file) =>
        // The retirement guards themselves quote removed routes/packages to assert their absence.
        !file.includes("ai-package-consumer-check") &&
        !file.startsWith("apps/app-server/src/scripts/openapi-export") &&
        !file.startsWith("scripts/smoke") &&
        !file.includes("/test/"),
    );
    if (offenders.length)
      throw new Error(`retirement gate [${label}] still referenced by:\n${offenders.join("\n")}`);
  }

  // 4. Business package dependency boundaries.
  const qaPackage = JSON.parse(readFileSync(join(repoRoot, "packages/ai-qa/package.json"), "utf8"));
  const writingPackage = JSON.parse(
    readFileSync(join(repoRoot, "packages/ai-writing/package.json"), "utf8"),
  );
  const depsOf = (pkg) => Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
  const qaDeps = depsOf(qaPackage);
  const writingDeps = depsOf(writingPackage);
  if (qaDeps.some((dep) => dep.includes("ai-writing") || dep.includes("dsh")))
    throw new Error("@zhishu/ai-qa must not depend on writing or DSH");
  if (writingDeps.some((dep) => dep.includes("ai-qa") || dep.includes("langchain")))
    throw new Error("@zhishu/ai-writing must not depend on qa or LangChain");
  for (const deps of [qaDeps, writingDeps])
    if (
      deps.some((dep) => dep.startsWith("fastify") || dep === "pg" || dep.startsWith("drizzle-orm"))
    )
      throw new Error("business packages must not depend on HTTP/database layers");

  // 5. Skill resources ship inside the packed artifacts (reading above already proved resolution works).
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "isolated installation",
        "official multi-turn writing consumer",
        "public declarations and SSR",
        "skill resource files",
        "retired engine scan (15.1)",
        "business package boundaries",
      ],
      packages: [...workspacePackages, "writing-consumer-example"],
    }),
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
