import {
  applyPreviewFrame,
  isStreamFrame,
  type AiEvent,
  type ConversationSnapshot,
  type PreviewFrame,
  type PreviewState,
  type StreamFrame,
} from '@zhishu/chat-contracts';
import { apiBaseUrl, getAccessToken } from '../../api/transport';
import { sseData } from '../../api/sse';

/**
 * Shared conversation transport for the unified assistant (and the public ask page).
 * Only framing, cursor, cancellation and request keys live here; business session state is
 * owned by each feature hook. Durable events merge through the pure chat-contracts reducer;
 * live preview frames only feed the bounded text preview and are never authoritative.
 */

export interface ConversationTransport {
  /** Overrides the API prefix, e.g. the public visitor namespace. */
  base: string;
  credentials?: RequestCredentials;
}

export const internalTransport = (): ConversationTransport => ({
  base: `${apiBaseUrl}/api/ai`,
});

export const publicTransport = (siteId: string): ConversationTransport => ({
  base: `${apiBaseUrl}/api/public/qa-sites/${siteId}`,
  credentials: 'include' as const,
});

async function request<T>(
  transport: ConversationTransport,
  path: string,
  init: RequestInit,
  token: string,
): Promise<T> {
  const response = await fetch(`${transport.base}${path}`, {
    ...init,
    credentials: transport.credentials,
    headers: {
      // Only declare JSON when a body is actually sent: body-less POSTs (cancel/retry)
      // with this header are rejected by Fastify as FST_ERR_CTP_EMPTY_JSON_BODY.
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(transport.credentials ? {} : { authorization: `Bearer ${token}` }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let code = 'ERROR';
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { code?: string; message?: string };
      if (body.code) code = body.code;
      if (body.message) message = body.message;
    } catch {
      /* keep defaults */
    }
    throw Object.assign(new Error(message), { code, status: response.status });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function accessToken(): string {
  const token = getAccessToken();
  if (!token && !location.origin.includes('localhost')) throw new Error('请先登录');
  return token ?? '';
}

export const createConversation = <T>(transport: ConversationTransport, body: unknown) =>
  request<T>(
    transport,
    `/conversations`,
    { method: 'POST', body: JSON.stringify(body ?? {}) },
    accessToken(),
  );

export const listConversations = <T>(transport: ConversationTransport) =>
  request<T[]>(transport, `/conversations`, { method: 'GET' }, accessToken());

export const submitMessage = <T>(
  transport: ConversationTransport,
  conversationId: string,
  body: unknown,
  signal: AbortSignal,
) =>
  request<T>(
    transport,
    `/conversations/${conversationId}/messages`,
    { method: 'POST', body: JSON.stringify(body), signal },
    accessToken(),
  );

export const fetchSnapshot = (
  transport: ConversationTransport,
  conversationId: string,
  before?: string,
) =>
  request<ConversationSnapshot>(
    transport,
    `/conversations/${conversationId}${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    { method: 'GET' },
    accessToken(),
  );

export const cancelRun = (
  transport: ConversationTransport,
  conversationId: string,
  runId: string,
) =>
  request<unknown>(
    transport,
    `/conversations/${conversationId}/runs/${runId}/cancel`,
    { method: 'POST' },
    accessToken(),
  );

export const retryRun = <T>(
  transport: ConversationTransport,
  conversationId: string,
  runId: string,
) =>
  request<T>(
    transport,
    `/conversations/${conversationId}/runs/${runId}/retry`,
    { method: 'POST' },
    accessToken(),
  );

export const updateContext = <T>(
  transport: ConversationTransport,
  conversationId: string,
  body: unknown,
) =>
  request<T>(
    transport,
    `/conversations/${conversationId}/context`,
    { method: 'POST', body: JSON.stringify(body) },
    accessToken(),
  );

/** Explicit user command creating a draft document from this conversation. */
export const createDraft = <T>(
  transport: ConversationTransport,
  conversationId: string,
  body: unknown,
) =>
  request<T>(
    transport,
    `/conversations/${conversationId}/draft`,
    { method: 'POST', body: JSON.stringify(body) },
    accessToken(),
  );

/** Explicit binding of an existing authorized document as the conversation target. */
export const bindTarget = <T>(
  transport: ConversationTransport,
  conversationId: string,
  body: unknown,
) =>
  request<T>(
    transport,
    `/conversations/${conversationId}/target`,
    { method: 'POST', body: JSON.stringify(body) },
    accessToken(),
  );

export const readArtifact = <T>(
  transport: ConversationTransport,
  conversationId: string,
  artifactId: string,
) =>
  request<T>(
    transport,
    `/artifacts/${artifactId}?conversationId=${encodeURIComponent(conversationId)}`,
    { method: 'GET' },
    accessToken(),
  );

/**
 * Subscribes to durable events + live previews. The caller refetches a snapshot when the
 * server signals resync (gap/backpressure) and on every terminal run transition. A dropped
 * connection releases only the subscription; it never cancels the run.
 */
export function observeConversation(input: {
  transport: ConversationTransport;
  conversationId: string;
  cursor: string;
  signal: AbortSignal;
  onEvent: (event: AiEvent) => void;
  onPreview: (frame: PreviewFrame) => void;
  onResync: () => void;
}): void {
  void (async () => {
    const token = accessToken();
    try {
      const response = await fetch(
        `${input.transport.base}/conversations/${input.conversationId}/events?cursor=${encodeURIComponent(input.cursor)}`,
        {
          headers: input.transport.credentials ? {} : { authorization: `Bearer ${token}` },
          credentials: input.transport.credentials,
          signal: input.signal,
        },
      );
      if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
      for await (const data of sseData(response)) {
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          continue;
        }
        if (!isStreamFrame(frame) || frame.conversationId !== input.conversationId) {
          input.onResync();
          return;
        }
        if (frame.type === 'resync-required') input.onResync();
        else if (frame.type === 'preview') input.onPreview(frame);
        else input.onEvent(frame);
      }
    } catch (error) {
      if (!input.signal.aborted) {
        void error;
        input.onResync();
      }
    }
  })();
}

/** Bounded per-run live preview merge reusing the shared pure reducer. */
export function mergePreview(
  previews: Record<string, PreviewState>,
  frame: PreviewFrame,
): Record<string, PreviewState> {
  const state = applyPreviewFrame(previews[frame.runId], frame);
  return state ? { ...previews, [frame.runId]: state } : previews;
}

export type { StreamFrame };
