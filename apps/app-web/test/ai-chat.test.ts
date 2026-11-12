import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPreviewFrame } from '@zhishu/chat-contracts';
import { renderWritingMarkdown } from '../src/components/chat/markdown';
import { sseData } from '../src/api/sse';

test('markdown keeps LaTeX for the document import pipeline', () => {
  const html = renderWritingMarkdown(
    '行内 $a^2$ 公式\n\n$$\n\\frac{1}{2}\n$$\n\n```\n$$literal$$\n```',
  );
  assert.match(html, /data-type="inline-math"/);
  assert.match(html, /data-type="block-math"/);
  assert.equal((html.match(/data-type="block-math"/g) ?? []).length, 1);
  assert.ok(html.includes('$literal$'), 'fenced code keeps literal dollars');
});

test('preview frames merge by epoch/attempt/revision/index and never rewind', () => {
  const frame = (index: number, text: string, attempt = 1, revision = 1) => ({
    type: 'preview' as const,
    conversationId: 'conv_1',
    purpose: 'writing' as const,
    runId: 'run_1',
    streamEpoch: 'epoch_1',
    attempt,
    contextRevision: 1,
    revision,
    index,
    channel: 'text' as const,
    text,
  });
  let preview = applyPreviewFrame(undefined, frame(0, '你好'));
  preview = applyPreviewFrame(preview, frame(1, '，世界'));
  assert.equal(preview?.text, '你好，世界');
  preview = applyPreviewFrame(preview, frame(1, '重复'));
  assert.equal(preview?.text, '你好，世界');
  preview = applyPreviewFrame(preview, frame(4, '跳洞'));
  assert.equal(preview?.incomplete, true);
  assert.equal(preview?.text, '');
  preview = applyPreviewFrame(preview, frame(0, '新尝试', 2));
  assert.equal(preview?.text, '新尝试');
  assert.equal(preview?.incomplete, false);
});

test('sseData reassembles split UTF-8 frames and enforces limits', async () => {
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
