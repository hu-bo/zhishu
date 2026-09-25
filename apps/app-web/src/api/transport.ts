import { z } from 'zod';
import { ApiError } from './api-error';

const envelope = z.object({
  code: z.string(),
  requestId: z.string().max(100).optional(),
  details: z.object({ field: z.string() }).optional(),
});
const messages: Record<string, string> = {
  NOT_FOUND: '这个工作流不存在或已被删除。',
  CONFLICT: '这个标识已被使用，请换一个。',
  INVALID_INPUT: '请检查填写的内容后重试。',
  PAYLOAD_TOO_LARGE: '提交的内容过大，请精简后重试。',
};

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...options, credentials: 'same-origin' });
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
