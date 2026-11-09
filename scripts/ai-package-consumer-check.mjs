import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile),
  pnpm = process.env.npm_execpath;
assert.ok(pnpm, "Run through pnpm check:ai-packages");
const parent = resolve(root, "output/qa");
await mkdir(parent, { recursive: true });
const packs = await mkdtemp(join(parent, "ai-packages-"));
const names = [
  "document-contracts",
  "ai-contracts",
  "chat-contracts",
  "chat-ui",
  "dsh-agent",
  "ai-plugins",
  "ai-runtime",
];
for (const name of names)
  await run(process.execPath, [pnpm, "pack", "--pack-destination", packs], {
    cwd: resolve(root, "packages", name),
    maxBuffer: 4000000,
  });
const files = await readdir(packs),
  dependencies = {};
for (const name of names) {
  const file = files.find((f) => f === `zhishu-${name}-0.1.0.tgz`);
  assert.ok(file, name);
  dependencies[`@zhishu/${name}`] = `file:${join(packs, file).replaceAll("\\", "/")}`;
}
const scratch = await mkdtemp(join(tmpdir(), "zhishu-ai-consumer-"));
await writeFile(
  join(scratch, "package.json"),
  JSON.stringify(
    {
      name: "isolated-ai-consumer",
      private: true,
      type: "module",
      dependencies: {
        ...dependencies,
        react: "19.2.8",
        "react-dom": "19.2.8",
        "@deepseek-ai/cordis": "4.0.5",
        "@deepseek-ai/dsh-llm": "0.2.1-rc.2",
        "@deepseek-ai/dsh-session": "0.2.1-rc.2",
        "@deepseek-ai/dsh-session-persistence": "0.2.1-rc.2",
      },
      devDependencies: {
        typescript: "5.9.3",
        "@types/node": "22.20.1",
        "@types/react": "19.2.18",
        "@types/react-dom": "19.2.7",
      },
      pnpm: { overrides: dependencies },
    },
    null,
    2,
  ),
);
await run(process.execPath, [pnpm, "install", "--ignore-scripts"], {
  cwd: scratch,
  maxBuffer: 4000000,
});
for (const file of ["index.mjs", "host.mjs"])
  await copyFile(resolve(root, "examples/dsh-consumer", file), join(scratch, file));
const execution = await run(process.execPath, ["index.mjs"], { cwd: scratch });
assert.match(execution.stdout, /官方 Agent Loop/);
await writeFile(
  join(scratch, "consumer.tsx"),
  `import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chat, Composer, type MessageView } from '@zhishu/chat-ui';
import { isSubmitChatMessage, isApprovalDecision, applyChatSnapshot } from '@zhishu/chat-contracts';
import { manifests, isImageJob } from '@zhishu/ai-plugins/contracts';
import { installWriting } from '@zhishu/ai-plugins/writing';
import { installResearch } from '@zhishu/ai-plugins/research';
import { installImage } from '@zhishu/ai-plugins/image';
import { hashContent as compilerHash } from '@zhishu/ai-plugins/writing/compiler';
import { AiRuntimeError } from '@zhishu/ai-plugins/errors';
import { createChatRuntime } from '@zhishu/ai-runtime/chat';
import { hashContent } from '@zhishu/ai-runtime/policy';
import type { createAuthoringRuntime } from '@zhishu/ai-runtime/legacy-authoring';
import type { RuntimeOptions } from '@zhishu/dsh-agent';
const messages: MessageView[] = [{ id:'one', role:'assistant',parts:[{id:'p',kind:'text',text:'独立安装'}] }];
const html = renderToStaticMarkup(<Chat messages={messages} composer={<Composer value="" maxLength={8000} onValueChange={()=>{}} onSubmit={()=>{}}/>}/>);
if (compilerHash('policy') !== hashContent('policy') || new AiRuntimeError('MODEL_FAILED').code !== 'MODEL_FAILED' || typeof createChatRuntime !== 'function' || !html.toLowerCase().includes('maxlength="8000"')) throw new Error('public subpath consumer failed');
type LegacyFactory = typeof createAuthoringRuntime; const legacyType: LegacyFactory | undefined = undefined; void legacyType;
if (!html.includes('独立安装') || !isSubmitChatMessage({clientMessageId:'m',idempotencyKey:'k',text:'hello'}) || !isApprovalDecision({approvalId:'a',decisionId:'d',decision:'allow-once'}) || typeof applyChatSnapshot !== 'function' || !isImageJob({id:'i',status:'unknown'}) || manifests.length !== 3) throw new Error('consumer failed');
const configure:RuntimeOptions['setup']=(ctx)=>{void installWriting;void installResearch;void installImage;void ctx;};void configure;
`,
);
await writeFile(
  join(scratch, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      outDir: "dist",
    },
    include: ["consumer.tsx"],
  }),
);
await run(
  process.execPath,
  [resolve(scratch, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
  { cwd: scratch, maxBuffer: 4000000 },
);
await run(process.execPath, ["dist/consumer.js"], { cwd: scratch });
const css = await readFile(
  resolve(scratch, "node_modules/@zhishu/chat-ui/dist/styles.css"),
  "utf8",
);
assert.ok(css.includes(".zhishu-chat"));
await writeFile(
  join(packs, "result.json"),
  JSON.stringify(
    {
      packages: names,
      checks: [
        "isolated installation",
        "public declarations",
        "React SSR",
        "standalone CSS",
        "browser-safe plugin contracts",
        "official multi-turn kernel consumer",
      ],
      consumer: scratch,
    },
    null,
    2,
  ),
);
console.log(
  `Packed AI packages independently installed and consumed successfully. Evidence: ${packs}`,
);
