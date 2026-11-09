import assert from 'node:assert/strict';
import test from 'node:test';
import { sseData } from '../src/api/sse.ts';
import { appendWritingPreview } from '../src/components/writing-chat/preview.ts';
import { renderWritingMarkdown } from '../src/components/writing-chat/markdown.ts';
import type { ChatLiveFrame } from '@zhishu/chat-contracts';

const delta: ChatLiveFrame = {
  type: 'assistant.delta',
  conversationId: 'writing',
  runId: 'run',
  streamEpoch: 'epoch',
  attempt: 1,
  revision: 1,
  index: 0,
  text: '你好',
};

test('writing Markdown keeps LaTeX source for document import and leaves fenced code literal', () => {
  const html = renderWritingMarkdown(
    [
      '$$a^2 - b^2 = (a+b)(a-b)$$s',
      '$$(a+b)^2 = a^2 + 2ab + b^2$$',
      String.raw`$$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$`,
      '',
      '```text',
      '$$literal$$',
      '```',
    ].join('\n'),
  );
  assert.equal((html.match(/data-type="inline-math"/g) ?? []).length, 1);
  assert.equal((html.match(/data-type="block-math"/g) ?? []).length, 2);
  assert.match(html, /<\/span>s<\/p>/);
  assert.match(html, /<mfrac>/);
  assert.ok(html.includes(String.raw`data-latex="x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"`));
  assert.ok(html.includes('$$literal$$'));
});

test('writing preview rejects duplicates, old revisions, missing prefixes and midstream gaps', () => {
  const first = appendWritingPreview(undefined, delta);
  assert.equal(appendWritingPreview(first, delta), first);
  const second = appendWritingPreview(first, { ...delta, index: 1, text: '，知书' });
  assert.equal(second.text, '你好，知书');
  const gap = appendWritingPreview(second, { ...delta, index: 3 });
  assert.equal(gap.incomplete, true);
  assert.equal(gap.text, '');
  assert.equal(appendWritingPreview(gap, { ...delta, index: 4 }).incomplete, true);
  const replacement = appendWritingPreview(gap, { ...delta, revision: 8 });
  assert.equal(replacement.text, '你好');
  assert.equal(appendWritingPreview(replacement, { ...delta, index: 5 }), replacement);
  assert.equal(appendWritingPreview(undefined, { ...delta, index: 2 }).incomplete, true);
  const restarted = appendWritingPreview(second, { ...delta, streamEpoch: 'new', index: 1 });
  assert.equal(restarted.text, '');
  assert.equal(restarted.incomplete, true);
  assert.equal(appendWritingPreview(first, { ...delta, attempt: 2 }).text, '你好');
});

test('shared SSE framing preserves split UTF-8/CRLF, releases readers, and rejects truncated or oversized frames', async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"text":"中文"}\r\n\r\n');
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  for await (const frame of sseData(response)) {
    assert.deepEqual(JSON.parse(frame), { text: '中文' });
    break;
  }
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
  await assert.rejects(async () => {
    for await (const frame of sseData(new Response('data: {}'))) void frame;
  }, /中断/);
  await assert.rejects(async () => {
    for await (const frame of sseData(new Response('data: 123456\n\n'), 5)) void frame;
  }, /限制/);
});
