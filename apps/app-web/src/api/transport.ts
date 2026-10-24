import { z } from 'zod';
import { ApiError } from './api-error';
import type { ExportDocumentJson200 } from './generated/models';
import {
  cacheResponse,
  cachedResponse,
  currentCacheIdentity,
  evictUnauthorizedResponses,
  hasVerifiedAccount,
  responseCacheScope,
  revokeOfflineAccount,
} from '@/features/offline/cache';

let accessToken: string | undefined;
export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const accessTokenListeners = new Set<(token: string | undefined) => void>();
type UnconfirmedChangeRegistration = {
  hasChanges: () => boolean;
  exportDraft?: () => ExportDocumentJson200 | null;
  discard?: () => void | Promise<void>;
};

const unconfirmedChangeProbes = new Set<UnconfirmedChangeRegistration>();

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

export function registerUnconfirmedChangeProbe(
  hasChanges: () => boolean,
  exportDraft?: () => ExportDocumentJson200 | null,
  discard?: () => void | Promise<void>,
) {
  const registration = { hasChanges, exportDraft, discard };
  unconfirmedChangeProbes.add(registration);
  return () => {
    unconfirmedChangeProbes.delete(registration);
  };
}
export async function discardUnconfirmedChanges(): Promise<void> {
  for (const registration of unconfirmedChangeProbes) {
    if (registration.hasChanges()) await registration.discard?.();
  }
}

export function hasUnconfirmedChanges() {
  for (const { hasChanges } of unconfirmedChangeProbes) {
    try {
      if (hasChanges()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function exportableUnconfirmedDrafts(): ExportDocumentJson200[] {
  const drafts: ExportDocumentJson200[] = [];
  for (const registration of unconfirmedChangeProbes) {
    if (!registration.exportDraft) continue;
    try {
      if (!registration.hasChanges()) continue;
      const draft = registration.exportDraft();
      if (draft) drafts.push(draft);
    } catch {
      // A destroyed or invalid editor must not prevent exporting other active drafts.
    }
  }
  return drafts;
}

export function createDocumentDraftExport(
  input: Pick<ExportDocumentJson200, 'title' | 'schemaVersion' | 'extensions' | 'content'>,
): ExportDocumentJson200 {
  return {
    format: 'zhishu.document',
    formatVersion: 1,
    title: input.title,
    schemaVersion: input.schemaVersion,
    extensions: input.extensions,
    content: input.content,
  };
}

const envelope = z.object({
  code: z.string(),
  requestId: z.string().max(100).optional(),
  details: z.object({ field: z.string() }).optional(),
});
const messages: Record<string, string> = {
  UNAUTHENTICATED: '身份认证已失效，请重新登录后再试。',
  NOT_FOUND: '这篇文档不存在或已被移除。',
  CONFLICT: '文档已在其他位置更新，请重新加载后再试。',
  IDEMPOTENCY_KEY_REUSED: '请求键已用于不同内容，请重新提交。',
  INVALID_INPUT: '请检查填写的内容后重试。',
  PAYLOAD_TOO_LARGE: '提交的内容过大，请精简后重试。',
};

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = apiBaseUrl;
  let response: Response;
  const identity = currentCacheIdentity();
  const cacheScope = responseCacheScope(path, options);
  if (cacheScope && (!navigator.onLine || !hasVerifiedAccount())) {
    const cached = await cachedResponse(cacheScope, path);
    if (cached.found) return cached.value as T;
    throw new ApiError(0, 'CACHE_MISS', '这部分内容尚未缓存，联网并登录后可读取。');
  }
  if (
    identity &&
    !hasVerifiedAccount() &&
    options.method &&
    options.method.toUpperCase() !== 'GET' &&
    path !== '/api/auth/mock/login'
  )
    throw new ApiError(
      401,
      'UNAUTHENTICATED',
      '请重新登录并确认权限后再提交修改。本机草稿会保留。',
    );
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
    if (cacheScope) {
      const cached = await cachedResponse(cacheScope, path);
      if (cached.found) return cached.value as T;
    }
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务，请检查网络后重试。');
  }
  if (!response.ok) {
    if (
      identity &&
      (response.status === 401 || response.status === 403 || response.status === 404)
    ) {
      await evictUnauthorizedResponses(identity, path, response.status === 401);
      if (response.status === 401) revokeOfflineAccount();
    }
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
  const value: unknown = await response.json();
  if (cacheScope) void cacheResponse(cacheScope, path, value);
  else if (
    identity &&
    options.method?.toUpperCase() === 'PUT' &&
    /^\/api\/documents\/doc_[A-Za-z0-9_-]+\/content$/.test(path)
  )
    await cacheResponse(identity, path, value);
  return value as T;
}

export type ErrorType<Error> = ApiError & { readonly serverErrorType?: Error };
export type BodyType<Body> = Body;
