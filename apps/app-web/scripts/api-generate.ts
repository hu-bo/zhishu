import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'orval';
import config from '../orval.config.ts';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const root = join(workspace, 'src/api/generated');

async function snapshot(directory: string, prefix = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, content] of await snapshot(path, `${name}/`)) files.set(key, content);
    } else files.set(name, await readFile(path, 'utf8'));
  }
  return files;
}

// Keep Orval's clean/write cycle outside Vite's watched source tree. The sibling
// transport preserves the same relative import as src/api/generated/app-api.ts.
const cache = join(workspace, 'node_modules/.cache');
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(join(cache, 'orval-'));
try {
  await copyFile(join(workspace, 'src/api/transport.ts'), join(temporary, 'transport.ts'));
  const projects = await (typeof config === 'function' ? config() : config);
  const definition = projects.appServer;
  const project = await (typeof definition === 'function' ? definition() : definition);
  if (!project || typeof project.output !== 'object') {
    throw new Error('Expected appServer output configuration');
  }
  const mutator = project.output.override?.mutator;
  if (!mutator || typeof mutator !== 'object') {
    throw new Error('Expected appServer transport mutator configuration');
  }
  await generate(
    {
      ...project,
      output: {
        ...project.output,
        target: join(temporary, 'generated/app-api.ts'),
        ...('schemas' in project.output ? { schemas: join(temporary, 'generated/models') } : {}),
        override: {
          ...project.output.override,
          mutator: { ...mutator, path: join(temporary, 'transport.ts') },
        },
      },
    },
    workspace,
    { throwOnError: true },
  );
  const before = await snapshot(root);
  const after = await snapshot(join(temporary, 'generated'));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (file) => before.get(file) !== after.get(file),
  );
  // Publish additions and updates before removing obsolete models. Never touch
  // unchanged files: checks and repeated builds must leave a running dev idle.
  for (const file of changed) {
    const content = after.get(file);
    if (content === undefined) continue;
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await rename(join(temporary, 'generated', file), path);
  }
  for (const file of changed) {
    if (!after.has(file)) await rm(join(root, file));
  }
  if (process.argv.includes('--check') && changed.length) {
    console.error(`Generated API drift detected (files regenerated):\n${changed.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`Generated API: ${changed.length} changed files.`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
