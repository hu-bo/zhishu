import { createAiEventValidator, type AiTaskEventV2 } from '@zhishu/ai-contracts';
import type { StartAiChatBody } from '@/api/generated/app-api.schemas';
import { apiBaseUrl, getAccessToken } from '@/api/transport';
import { ApiError } from '@/api/api-error';
import { sseData } from '@/api/sse';
/** RAG keeps its existing LangChain v2 task wire format and disconnect semantics. */
export async function consumeRagTask(
  body: StartAiChatBody,
  signal: AbortSignal,
  receive: (event: AiTaskEventV2) => void,
) {
  const token = getAccessToken();
  if (!token) throw new Error('请先登录');
  const response = await fetch(`${apiBaseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const code =
      value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
        ? value.code
        : 'HTTP_ERROR';
    const message =
      value && typeof value === 'object' && 'message' in value && typeof value.message === 'string'
        ? value.message
        : '问答暂未受理，请查询原请求或重新选择资料';
    throw new ApiError(response.status, code, message);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return;
  const validator = createAiEventValidator({
      requestId: body.request.requestId,
      protocolVersion: 2,
    }),
    seen = new Set<number>();
  for await (const data of sseData(response, 65536)) {
    const checked = validator.push(JSON.parse(data));
    if (!checked.success) throw new Error('问答响应不完整，请查询原请求');
    if (!seen.has(checked.data.seq)) {
      seen.add(checked.data.seq);
      receive(checked.data);
    }
  }
  if (!validator.finish().success) throw new Error('问答连接已中断，可查询并恢复原任务');
}
