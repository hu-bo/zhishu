import { z } from 'zod';
import { ApiError } from './api-error';

let accessToken: string | undefined;
const accessTokenListeners = new Set<(token: string | undefined) => void>();
const unconfirmedChangeProbes = new Set<() => boolean>();

export function setAccessToken(token: string | undefined) {
  if (accessToken === token) return;
  accessToken = token;
  for (const listener of accessTokenListeners) listener(token);
}

export function getAccessToken() {
  return accessToken;
}

export function subscribeAccessToken(listener: (token: string | undefined) => void) {
  accessTokenListeners.add(listener);
  return () => accessTokenListeners.delete(listener);
}

export function registerUnconfirmedChangeProbe(probe: () => boolean) {
  unconfirmedChangeProbes.add(probe);
  return () => unconfirmedChangeProbes.delete(probe);
}

export function hasUnconfirmedChanges() {
  for (const probe of unconfirmedChangeProbes) {
    try {
      if (probe()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

const envelope = z.object({
  code: z.string(),
  requestId: z.string().max(100).optional(),
  details: z.object({ field: z.string() }).optional(),
});
const messages: Record<string, string> = {
  NOT_FOUND: '这篇文档不存在或已被移除。',
  CONFLICT: '文档已在其他位置更新，请重新加载后再试。',
  INVALID_INPUT: '请检查填写的内容后重试。',
  PAYLOAD_TOO_LARGE: '提交的内容过大，请精简后重试。',
};

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
  let response: Response;
  try {
    const headers = new Headers(options.headers);
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    response = await fetch(`${base}${path}`, {
      ...options,
      headers,
      credentials: 'same-origin',
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务，请检查网络后重试。');
  }
  if (!response.ok) {
    const parsed = envelope.safeParse(await response.json().catch(() => null));
    const code = parsed.success ? parsed.data.code : 'HTTP_ERROR';
    throw new ApiError(
      response.status,
      code,
      messages[code] ?? '服务暂时不可用，请稍后重试。',
      parsed.success ? parsed.data.requestId : undefined,
      parsed.success ? parsed.data.details?.field : undefined,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export type ErrorType<Error> = ApiError & { readonly serverErrorType?: Error };
export type BodyType<Body> = Body;
