import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWritingMarkdown } from '../src/components/chat/markdown';
import { renderAnswerHtml } from '../src/components/chat/answer-markdown';
import type { CitationPresentation } from '../src/components/chat/citation-model';
import { sseData } from '../src/api/sse';

const citedPresentation = {
  citation: {
    citationId: 'cit_1',
    evidenceArtifactId: 'art_1',
    evidenceId: 'ev_1',
    locator: { kind: 'block', blockId: 'blk_1', start: 0, end: 4 },
    quote: '关键结论',
  },
  ordinal: 1,
  title: '架构规范',
  kind: 'document',
  documentId: 'doc_1',
  excerpt: '关键结论',
} satisfies CitationPresentation;

test('markdown keeps LaTeX for the document import pipeline', () => {
  const html = renderWritingMarkdown(
    '行内 $a^2$ 公式\n\n$$\n\\frac{1}{2}\n$$\n\n```\n$$literal$$\n```',
  );
  assert.match(html, /data-type="inline-math"/);
  assert.match(html, /data-type="block-math"/);
  assert.equal((html.match(/data-type="block-math"/g) ?? []).length, 1);
  assert.ok(html.includes('$literal$'), 'fenced code keeps literal dollars');
});

test('answer markdown marks the first occurrence of a citation quote and preserves blocks', () => {
  const html = renderAnswerHtml('## 摘要\n\n- 关键结论成立，再述关键结论。\n\n以上。', [
    citedPresentation,
  ]);
  assert.match(html, /<h2>摘要<\/h2>/);
  assert.match(
    html,
    /<li>关键结论<button type="button" class="citation-mark" data-citation-ordinal="1" aria-label="来源 1">\[1\]<\/button>成立，再述关键结论。<\/li>/,
  );
  assert.ok(!html.includes('@@cite'), 'tokens never leak into the rendered HTML');
  assert.ok(
    !renderAnswerHtml('无引用的回答', []).includes('citation-mark'),
    'no citations means no marks',
  );
});

test('sseData reassembles split UTF-8 frames and ignores heartbeats', async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode('data: {"a":"中😀"}\n\n: heartbeat\ndata: {"b":1}\n\n');
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of sseData(new Response(body))) frames.push(frame);
  assert.deepEqual(frames, ['{"a":"中😀"}', '{"b":1}']);
});
