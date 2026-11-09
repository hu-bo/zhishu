import {
  createAiEventValidator,
  validateAiTaskRequestV2,
  type AuthoringRequest,
  type AiTaskEvent,
} from '@zhishu/ai-contracts';
import { z } from 'zod';
import type { StartAiAuthoringBody } from '@/api/generated/app-api.schemas';
import { apiBaseUrl, getAccessToken } from '@/api/transport';
import { ApiError } from '@/api/api-error';
import { sseData } from '@/api/sse';

export interface ProposalMessage {
  id: string;
  instruction: string;
  body: StartAiAuthoringBody;
  /** Read-only compatibility for incomplete pre-migration drafts. */
  preview?: string;
  registered: boolean;
  reviewPending?: boolean;
  dismissed?: boolean;
  targetTitle?: string;
  error?: string;
}
function nodeText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as {
    type?: unknown;
    text?: unknown;
    content?: unknown;
    attrs?: { latex?: unknown };
  };
  if (typeof node.attrs?.latex === 'string') {
    if (node.type === 'inlineMath') return `$${node.attrs.latex}$`;
    if (node.type === 'blockMath') return `$$\n${node.attrs.latex}\n$$`;
  }
  return typeof node.text === 'string'
    ? node.text
    : Array.isArray(node.content)
      ? node.content.map(nodeText).join('')
      : '';
}
export function proposalText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
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
const sourceIds = z
  .array(z.string().min(1).max(256))
  .max(4)
  .refine((ids) => new Set(ids).size === ids.length);
const proposalDraft = z.object({
  instruction: z.string().max(8000),
  messages: z
    .array(
      z
        .object({
          id: z.string(),
          instruction: z.string().max(8000),
          preview: z.string().max(64000).optional(),
          reviewPending: z.boolean().optional(),
          dismissed: z.boolean().optional(),
          targetTitle: z.string().max(512).optional(),
          body: z.object({
            protocolVersion: z.literal(1),
            sourceDocumentIds: sourceIds,
            previousRequestIds: z
              .array(z.string().min(1).max(128))
              .max(16)
              .refine((ids) => new Set(ids).size === ids.length)
              .optional(),
            request: z.custom<AuthoringRequest>((value) => {
              const checked = validateAiTaskRequestV2(value);
              return checked.success && checked.data.kind === 'authoring';
            }),
          }),
        })
        .refine((message) => message.id === message.body.request.requestId),
    )
    .max(16),
});
export function readProposalDraft(
  value: unknown,
): { messages: ProposalMessage[]; instruction: string } | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('messages' in value) ||
    !Array.isArray(value.messages) ||
    value.messages.length > 16 ||
    JSON.stringify(value).length > 16777216
  )
    return null;
  // Original mixed cache is kept intact. RagChat reads its own records independently.
  const messages = value.messages.filter((message) => {
    const request = message?.body?.request;
    const checked = validateAiTaskRequestV2(request);
    return !(checked.success && checked.data.kind === 'chat');
  });
  const checked = proposalDraft.safeParse({ ...value, messages });
  if (!checked.success) return null;
  return {
    instruction: checked.data.instruction,
    messages: checked.data.messages.map((message) => ({ ...message, registered: true })),
  };
}
export async function consumeAuthoringTask(
  body: StartAiAuthoringBody,
  signal: AbortSignal,
  onEvent: (event: AiTaskEvent) => void,
) {
  const token = getAccessToken();
  if (!token || !navigator.onLine)
    throw new ApiError(401, 'UNAUTHENTICATED', '请联网并登录后开始创作。');
  const response = await fetch(`${apiBaseUrl}/api/ai/authoring`, {
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
  const validator = createAiEventValidator({ requestId: body.request.requestId });
  const seen = new Set<number>();
  for await (const data of sseData(response, 65536)) {
    const checked = validator.push(JSON.parse(data));
    if (!checked.success) throw new Error('生成响应不完整，请查询任务状态。');
    if (!seen.has(checked.data.seq)) {
      seen.add(checked.data.seq);
      onEvent(checked.data);
    }
  }
  if (!validator.finish().success) throw new Error('生成连接已中断，已保留草稿，请查询原任务。');
}
