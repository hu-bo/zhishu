import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Alias } from 'vite';

/** Dev consumes workspace source so unrelated builds cannot invalidate the editor. */
export function workspaceSourceAliases(): Alias[] {
  return [
    'document-contracts',
    'ai-contracts',
    'chat-contracts',
    'chat-ui',
    'editor-core',
    'editor-collaboration',
    'editor-react',
    'editor-ui',
  ].flatMap((name) => {
    const root = new URL(`../../../packages/${name}/`, import.meta.url);
    const manifest: { name: string; exports: Record<string, string | { import: string }> } =
      JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    return Object.entries(manifest.exports).flatMap(([entry, target]) => {
      const path = typeof target === 'string' ? target : target.import;
      if (!path.startsWith('./dist/')) return [];
      const source = path.replace('./dist/', './src/');
      const candidate = /\.js$/.test(source)
        ? [source.replace(/\.js$/, '.ts'), source.replace(/\.js$/, '.tsx')].find((file) =>
            existsSync(new URL(file, root)),
          )
        : source;
      if (!candidate || !existsSync(new URL(candidate, root))) {
        throw new Error(`Missing workspace source: ${manifest.name}${entry.slice(1)}`);
      }
      const specifier = `${manifest.name}${entry === '.' ? '' : entry.slice(1)}`;
      return [
        {
          find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
          replacement: fileURLToPath(new URL(candidate, root)),
        },
      ];
    });
  });
}
