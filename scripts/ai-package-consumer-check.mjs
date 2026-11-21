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
  "rag",
  "dsh-agent",
  "ai-plugins",
  "ai-runtime",
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
  const localOverrides = Object.fromEntries(
    workspacePackages.map((name) => [`@zhishu/${name}`, `file:${archive(name)}`]),
  );

  // 1. Official-kernel standalone consumption: run the assistant example from packed archives only.
  await run("pnpm", [
    "--dir",
    "examples/assistant-consumer",
    "pack",
    "--pack-destination",
    workspace,
  ]);
  const exampleArchive = join(workspace, "zhishu-assistant-consumer-example-0.0.0.tgz");
  if (!existsSync(exampleArchive)) throw new Error(`missing example archive ${exampleArchive}`);
  const assistantExample = join(workspace, "assistant-consumer");
  await run("tar", ["-xzf", exampleArchive, "-C", workspace]);
  await rm(assistantExample, { recursive: true, force: true });
  renameSync(join(workspace, "package"), assistantExample);
  const examplePkgPath = join(assistantExample, "package.json");
  const examplePkg = JSON.parse(readFileSync(examplePkgPath, "utf8"));
  // Packed tarballs rewrite workspace protocols to versions; pin every transitive
  // @zhishu dependency back to the local archives so resolution never hits a registry.
  examplePkg.pnpm = { ...examplePkg.pnpm, overrides: localOverrides };
  examplePkg.overrides = localOverrides;
  examplePkg.dependencies = {
    ...examplePkg.dependencies,
    "@zhishu/ai-runtime": `file:${archive("ai-runtime")}`,
    "@zhishu/dsh-agent": `file:${archive("dsh-agent")}`,
    "@zhishu/ai-plugins": `file:${archive("ai-plugins")}`,
    "@zhishu/ai-contracts": `file:${archive("ai-contracts")}`,
  };
  writeFileSync(examplePkgPath, `${JSON.stringify(examplePkg, null, 2)}\n`);
  await run("pnpm", ["install", "--ignore-scripts"], { cwd: assistantExample });
  const exampleOutput = await run("node", ["index.mjs"], { cwd: assistantExample });
  if (!exampleOutput.includes("官方 Agent Loop"))
    throw new Error("assistant example did not reach the official kernel");

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
        pnpm: { overrides: localOverrides },
        overrides: localOverrides,
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
  validateWritingDraftPayload,
  canonicalJson,
} from "@zhishu/ai-contracts";
import { hashContent } from "@zhishu/ai-contracts/hash";
import { applyAiEvent, applyPreviewFrame, isSubmitMessage, isCreateDraft, isStreamFrame } from "@zhishu/chat-contracts";
import { Chat, Composer } from "@zhishu/chat-ui";
import { createDshRuntime, deterministicNativeSessionId, DshRuntimeError } from "@zhishu/dsh-agent";
import { LlmAdapter } from "@zhishu/dsh-agent/kernel";
import { createAssistantRuntime, INSUFFICIENT_EVIDENCE_TEXT } from "@zhishu/ai-runtime";
import { manifests, isImageJob } from "@zhishu/ai-plugins/contracts";
import { compileProposal, compileDraft, WritingOutputSchema } from "@zhishu/ai-plugins/compiler";
import { installRag } from "@zhishu/ai-plugins/rag";
import { installResearch } from "@zhishu/ai-plugins/research";
import { installWriting } from "@zhishu/ai-plugins/writing";
import { installImage } from "@zhishu/ai-plugins/image";
import { installScope } from "@zhishu/ai-plugins/scope";
import { loadSkillInstruction as loadPluginSkill, skillDefinitions as pluginSkills } from "@zhishu/ai-plugins/skills";
import { loadSkillInstruction, skillDefinitions, retrievalToolSchemas } from "@zhishu/rag";

const checks = [];
if (typeof createDshRuntime !== "function") throw new Error("dsh runtime missing");
if (typeof createAssistantRuntime !== "function") throw new Error("assistant runtime missing");
if (typeof LlmAdapter !== "function") throw new Error("kernel adapter missing");
if (!DshRuntimeError || !INSUFFICIENT_EVIDENCE_TEXT) throw new Error("runtime gates missing");
if (typeof compileProposal !== "function" || typeof compileDraft !== "function")
  throw new Error("pure compiler missing");
if (!WritingOutputSchema) throw new Error("output schema missing");
for (const install of [installRag, installResearch, installWriting, installImage, installScope])
  if (typeof install !== "function") throw new Error("plugin installer missing");
if (deterministicNativeSessionId("ai_x", 1) === deterministicNativeSessionId("ai_x", 2))
  throw new Error("native session ids must isolate context revisions");
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
if (typeof validateWritingRequest !== "function" || typeof validateWritingProposalPayload !== "function" || typeof validateWritingDraftPayload !== "function")
  throw new Error("writing validators missing");
if (typeof applyAiEvent !== "function" || typeof applyPreviewFrame !== "function")
  throw new Error("shared reducers missing");
if (
  !isSubmitMessage({
    clientMessageId: "c",
    idempotencyKey: "i",
    text: "问",
    expectedContextRevision: 1,
    intentHint: "qa",
  })
)
  throw new Error("submit contract broken");
if (isSubmitMessage({ purpose: "qa", clientMessageId: "c", idempotencyKey: "i", text: "问", expectedContextRevision: 1 }))
  throw new Error("purpose fork must be retired from the submit contract");
if (!isCreateDraft({ idempotencyKey: "d", instruction: "写", workspaceId: "ws_1", expectedContextRevision: 1 }))
  throw new Error("create-draft contract broken");
if (isStreamFrame({ type: "nope" })) throw new Error("frame guard broken");
const html = renderToString(
  createElement(Chat, {
    messages: [{ id: "1", role: "user", parts: [{ id: "p", kind: "text", text: "独立安装" }] }],
    composer: createElement(Composer, { value: "", onValueChange: () => {}, onSubmit: () => {} }),
  }),
);
if (!html.includes("独立安装")) throw new Error("chat-ui SSR failed");
if (manifests.length !== 5 || !isImageJob({ id: "j", status: "pending" }))
  throw new Error("plugin contracts broken");
const pluginSkill = await loadPluginSkill("writing");
if (!pluginSkill.includes("创建草稿")) throw new Error("plugin skill resource unreadable");
if (pluginSkills.length !== 5) throw new Error("plugin skill definitions broken");
const ragSkill = await loadSkillInstruction("rag");
if (!ragSkill.includes("知书")) throw new Error("rag skill resource unreadable");
if (skillDefinitions.length !== 2) throw new Error("skill definitions broken");
if (!retrievalToolSchemas.searchPlatform.name) throw new Error("tool schemas broken");
if (canonicalJson({ b: 1, a: [2] }) !== '{"a":[2],"b":1}') throw new Error("canonical json broken");
checks.push("contracts", "dsh-runtime", "assistant-runtime", "plugins", "chat-ui", "skill-resources");
console.log(JSON.stringify(checks));
`;
  writeFileSync(join(isolated, "consumer.mjs"), consumerSource);
  await run("node", ["consumer.mjs"], { cwd: isolated });

  // 3. Retirement gate: the dual engines and legacy protocols must be gone from production code.
  const scanPatterns = [
    ["retired package imports", 'from "@zhishu/(ai-qa|ai-writing)"'],
    [
      "legacy protocols",
      "AiTaskEvent|legacy-authoring|ChatRecord|ChatStore|PostgresSaver|deepagents|@langchain/langgraph|previousRequestIds|inputMessageId",
    ],
    [
      "retired routes",
      '"/api/ai/chat|"/api/ai/authoring|/api/ai/qa/|/api/ai/writing/|prefix: "/writing"',
    ],
    [
      "retired db shapes",
      'pgTable\\(\\s*"projects"|writing_events|pgTable\\(\\s*"writing_sessions"|pgTable\\(\\s*"writing_image_jobs"',
    ],
  ];
  for (const [label, pattern] of scanPatterns) {
    const offenders = grepFiles(pattern).filter(
      (file) =>
        // The retirement guards themselves quote removed routes/packages to assert their absence.
        !file.includes("ai-package-consumer-check") &&
        !file.startsWith("apps/app-server/src/scripts/openapi-export") &&
        !file.startsWith("scripts/smoke") &&
        !file.includes("/test/") &&
        !file.endsWith(".test.ts"),
    );
    if (offenders.length)
      throw new Error(`retirement gate [${label}] still referenced by:\n${offenders.join("\n")}`);
  }

  // 4. Business package dependency boundaries: the three packages stay free of HTTP/DB/LangChain.
  const depsOf = (name) => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, `packages/${name}/package.json`), "utf8"));
    return Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
  };
  for (const name of ["dsh-agent", "ai-plugins", "ai-runtime"]) {
    const deps = depsOf(name);
    if (deps.some((dep) => dep.includes("langchain") || dep.includes("deepagents")))
      throw new Error(`@zhishu/${name} must not depend on LangChain/Deep Agents`);
    if (
      deps.some((dep) => dep.startsWith("fastify") || dep === "pg" || dep.startsWith("drizzle-orm"))
    )
      throw new Error(`@zhishu/${name} must not depend on HTTP/database layers`);
    if (deps.some((dep) => dep.includes("ai-qa") || dep.includes("ai-writing")))
      throw new Error(`@zhishu/${name} must not depend on retired engines`);
  }
  // ai-runtime composes the kernel and plugins; plugins never reverse-depend on the runtime.
  if (depsOf("ai-plugins").some((dep) => dep.includes("ai-runtime")))
    throw new Error("@zhishu/ai-plugins must not depend on ai-runtime");
  if (!depsOf("ai-runtime").some((dep) => dep.includes("dsh-agent")))
    throw new Error("@zhishu/ai-runtime must compose @zhishu/dsh-agent");

  // 5. Skill resources ship inside the packed artifacts (reading above already proved resolution works).
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "isolated installation",
        "official unified assistant consumer",
        "public declarations and SSR",
        "skill resource files",
        "retired engine scan",
        "business package boundaries",
      ],
      packages: [...workspacePackages, "assistant-consumer-example"],
    }),
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
