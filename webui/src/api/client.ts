/**
 * API 客户端（分层铁律：UI 只经此层访问 /api/v1，凭证为会话 cookie）。
 * 401 → 广播 onUnauthorized（store 统一跳登录，避免逐组件弹错）。
 */
import type { ApiAction, ApiActionPage, ApiActionResult, ApiUser } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly type: string | undefined;

  constructor(status: number, message: string, type?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
  }
}

let unauthorizedHandler: (() => void) | undefined;

export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      credentials: 'include',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch {
    throw new ApiError(0, '网络不可达：无法连接 skyport 服务');
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401 && unauthorizedHandler !== undefined && path !== '/auth/login') {
      unauthorizedHandler();
    }
    throw new ApiError(
      response.status,
      typeof body.error === 'string' ? body.error : `请求失败（${response.status}）`,
      typeof body.type === 'string' ? body.type : undefined,
    );
  }
  return body as T;
}

export const api = {
  login: (username: string, password: string): Promise<{ user: ApiUser }> =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),

  logout: (): Promise<{ ok: boolean }> => request('/auth/logout', { method: 'POST' }),

  me: (): Promise<{ user: ApiUser | null }> => request('/auth/me'),

  listActions: (): Promise<ApiActionPage> => request('/actions?limit=200'),

  getAction: (id: string): Promise<ApiAction> => request(`/actions/${encodeURIComponent(id)}`),

  approve: (id: string): Promise<ApiActionResult> =>
    request(`/actions/${encodeURIComponent(id)}/approve`, { method: 'POST' }),

  reject: (id: string, note?: string): Promise<{ action: ApiAction }> =>
    request(`/actions/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: note === undefined ? undefined : JSON.stringify({ note }),
    }),
};
