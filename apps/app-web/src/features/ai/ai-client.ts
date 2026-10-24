import {
  createAiEventValidator,
  validateAiTaskRequestV2,
  type AiTaskEvent,
  type AiTaskEventV2,
} from '@zhishu/ai-contracts';
import type { StartAiAuthoringBody, StartAiChatBody } from '@/api/generated/models';
import { apiBaseUrl, getAccessToken } from '@/api/transport';
import { ApiError } from '@/api/api-error';
import { validateDocumentContent, type DocumentContent } from '@zhishu/document-contracts';
export type AiStartBody = StartAiAuthoringBody | StartAiChatBody;
export interface AiLocalMessage {
  id: string;
  instruction: string;
  body: AiStartBody;
  preview: string;
  stage: string;
  registered: boolean;
  beforeText: string;
  beforeContent?: DocumentContent;
  dismissed?: boolean;
  targetTitle?: string;
  error?: string;
}
export function nodeText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as { text?: unknown; content?: unknown };
  return typeof node.text === 'string'
    ? node.text
    : Array.isArray(node.content)
      ? node.content.map(nodeText).join('')
      : '';
}
export function proposalText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  if ('text' in result && typeof result.text === 'string') return result.text;
  if (
    !('operationBatch' in result) ||
    !result.operationBatch ||
    typeof result.operationBatch !== 'object'
  )
    return '';
  const batch = result.operationBatch as { operations?: unknown[] };
  return (batch.operations ?? [])
    .map((operation) =>
      operation && typeof operation === 'object' && 'block' in operation
        ? nodeText(operation.block)
        : '',
    )
    .filter(Boolean)
    .join('\n\n');
}
export function readAiDraft(
  value: unknown,
): { messages: AiLocalMessage[]; instruction: string } | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as { messages?: unknown; instruction?: unknown };
  if (
    !Array.isArray(draft.messages) ||
    draft.messages.length > 16 ||
    typeof draft.instruction !== 'string' ||
    draft.instruction.length > 8000
  )
    return null;
  if (JSON.stringify(value).length > 16777216) return null;
  const messages: AiLocalMessage[] = [];
  for (const raw of draft.messages) {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>,
      body = m.body as Record<string, unknown> | undefined;
    const checked = validateAiTaskRequestV2(body?.request);
    const previousRequestIds = body?.previousRequestIds;
    if (
      typeof m.id !== 'string' ||
      typeof m.instruction !== 'string' ||
      m.instruction.length > 8000 ||
      typeof m.preview !== 'string' ||
      m.preview.length > 64000 ||
      typeof m.beforeText !== 'string' ||
      m.beforeText.length > 256000 ||
      (m.beforeContent !== undefined &&
        (JSON.stringify(m.beforeContent).length > 256000 ||
          !validateDocumentContent(m.beforeContent).success)) ||
      (m.dismissed !== undefined && typeof m.dismissed !== 'boolean') ||
      (m.targetTitle !== undefined &&
        (typeof m.targetTitle !== 'string' || m.targetTitle.length > 512)) ||
      !body ||
      !checked.success ||
      checked.data.kind === 'answer' ||
      checked.data.requestId !== m.id ||
      !Array.isArray(body.sourceDocumentIds) ||
      body.sourceDocumentIds.length > 4 ||
      body.sourceDocumentIds.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
      new Set(body.sourceDocumentIds).size !== body.sourceDocumentIds.length ||
      (checked.data.kind === 'chat' ? body.protocolVersion !== 2 : body.protocolVersion !== 1) ||
      (previousRequestIds !== undefined &&
        (!Array.isArray(previousRequestIds) ||
          previousRequestIds.length > 16 ||
          previousRequestIds.some((id) => typeof id !== 'string' || !id || id.length > 128) ||
          new Set(previousRequestIds).size !== previousRequestIds.length))
    )
      return null;
    const restoredBody: AiStartBody =
      checked.data.kind === 'chat'
        ? { protocolVersion: 2, request: checked.data, sourceDocumentIds: body.sourceDocumentIds }
        : {
            protocolVersion: 1,
            request: checked.data,
            sourceDocumentIds: body.sourceDocumentIds,
            previousRequestIds: previousRequestIds as string[] | undefined,
          };
    messages.push({
      id: m.id,
      instruction: m.instruction,
      body: restoredBody,
      preview: m.preview,
      beforeText: m.beforeText,
      beforeContent: m.beforeContent as DocumentContent | undefined,
      dismissed: m.dismissed as boolean | undefined,
      targetTitle: m.targetTitle as string | undefined,
      registered: true,
      stage: '需要确认任务状态',
    });
  }
  return { messages, instruction: draft.instruction };
}
export async function consumeAiTask(
  body: AiStartBody,
  signal: AbortSignal,
  onEvent: (event: AiTaskEvent | AiTaskEventV2) => void,
) {
  const token = getAccessToken();
  if (!token || !navigator.onLine)
    throw new ApiError(401, 'UNAUTHENTICATED', '请联网并登录后开始创作。');
  const chat = body.request.kind === 'chat';
  const response = await fetch(`${apiBaseUrl}/api/ai/${chat ? 'chat' : 'authoring'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'HTTP_ERROR';
    throw new ApiError(
      response.status,
      code,
      response.status === 403
        ? '权限或资料已变化，相关草稿已隐藏。'
        : code === 'AI_WRITE_PERSONAL_ONLY'
          ? '请选择本人的个人文档作为写入位置。'
          : code === 'CONFLICT'
            ? '文档已更新，请重新生成。'
            : code === 'RESOURCE_LIMIT'
              ? '已有任务正在生成，请等待或停止后再试。'
              : '暂时无法开始生成，请查询任务状态后重试。',
    );
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return;
  if (!response.body) throw new Error('未能读取生成响应。');
  const validator = chat
    ? createAiEventValidator({ requestId: body.request.requestId, protocolVersion: 2 })
    : createAiEventValidator({ requestId: body.request.requestId });
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    bytes = 0;
  const seen = new Set<number>();
  const processFrame = (frame: string) => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const checked = validator.push(JSON.parse(data));
    if (!checked.success) throw new Error('生成响应不完整，请查询任务状态。');
    if (!seen.has(checked.data.seq)) {
      seen.add(checked.data.seq);
      onEvent(checked.data);
    }
  };
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      bytes += read.value.byteLength;
      if (bytes > 1048576) throw new Error('生成响应超出限制。');
      buffer += decoder.decode(read.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        processFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
      if (buffer.length > 65536) throw new Error('生成响应超出限制。');
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw new Error('生成连接已中断，请查询任务状态。');
    if (!validator.finish().success) throw new Error('生成连接已中断，已保留草稿，请查询原任务。');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
