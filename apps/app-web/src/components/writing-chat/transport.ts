import { apiBaseUrl, getAccessToken } from '@/api/transport';
import { isChatFrame, type ChatFrame } from '@zhishu/chat-contracts';
import { sseData } from '@/api/sse';
/** SSE is the streaming exception to the generated ordinary HTTP client. */
export async function observeWriting(
  conversationId: string,
  cursor: string,
  signal: AbortSignal,
  receive: (frame: ChatFrame) => void,
  ready?: () => void,
) {
  const token = getAccessToken();
  if (!token) throw new Error('请先登录');
  const response = await fetch(
    `${apiBaseUrl}/api/writing/conversations/${encodeURIComponent(conversationId)}/events?cursor=${encodeURIComponent(cursor)}`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
  if (!response.ok || !response.body) throw new Error('对话连接暂不可用，请重新连接');
  if (!signal.aborted) ready?.();
  for await (const data of sseData(response)) {
    if (signal.aborted) break;
    const value: unknown = JSON.parse(data);
    if (!isChatFrame(value) || value.conversationId !== conversationId)
      throw new Error('对话更新无效，请重新连接');
    receive(value);
  }
  if (!signal.aborted) throw new Error('连接已断开，生成仍可在服务端继续');
}
