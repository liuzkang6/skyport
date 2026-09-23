/**
 * API 客户端（分层铁律：UI 只经此层访问 /api/v1，凭证为会话 cookie）。
 * 401 → 广播 onUnauthorized（store 统一跳登录，避免逐组件弹错）。
 * 错误 message 优先取后端 body.error（人话）；429 附带 Retry-After 秒数。
 */
import type { ApiAction, ApiActionPage, ApiActionResult, ApiUser } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly type: string | undefined;
  /** 429 时取自 Retry-After 响应头（秒）；其余为 undefined */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, message: string, type?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.retryAfterSeconds = retryAfterSeconds;
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
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ApiError(
      response.status,
      typeof body.error === 'string' ? body.error : `请求失败（${response.status}）`,
      typeof body.type === 'string' ? body.type : undefined,
      response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return body as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs === '' ? '' : `?${qs}`;
}

export const api = {
  // ── 会话 ──
  login: (username: string, password: string): Promise<{ user: ApiUser }> =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),

  logout: (): Promise<{ ok: boolean }> => request('/auth/logout', { method: 'POST' }),

  me: (): Promise<{ user: ApiUser | null }> => request('/auth/me'),

  // ── 行动 ──
  listActions: (opts: { status?: string; actor?: string; limit?: number; offset?: number } = {}): Promise<ApiActionPage> =>
    request(`/actions${query({ status: opts.status, actor: opts.actor, limit: opts.limit ?? 200, offset: opts.offset })}`),

  getActionDetail: (id: string): Promise<ApiActionResult & { events?: readonly { id: number; event: string; actorType: string; actorId: string; detail: string | null; createdAt: string }[] }> =>
    request(`/actions/${encodeURIComponent(id)}`),

  approve: (id: string): Promise<ApiActionResult> =>
    request(`/actions/${encodeURIComponent(id)}/approve`, { method: 'POST' }),

  reject: (id: string, note?: string): Promise<{ action: ApiAction }> =>
    request(`/actions/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: note === undefined ? undefined : JSON.stringify({ note }),
    }),

  // ── 资产与态势 ──
  listAssets: (): Promise<{ assets: { id: string; name: string; type: string; addr: string | null; status: string; labels: Record<string, string>; lastCheckAt: string | null }[] }> =>
    request('/assets'),

  context: (asset: string): Promise<Record<string, unknown>> =>
    request(`/context/${encodeURIComponent(asset)}`),

  // ── 告警 ──
  listAlerts: (status?: string): Promise<{ alerts: { id: string; event: string; resource: string; severity: string; status: string; text: string | null; origin: string; timestamp: string; value: string | null }[] }> =>
    request(`/alerts${query({ status })}`),

  ackAlert: (id: string): Promise<Record<string, unknown>> =>
    request(`/alerts/${encodeURIComponent(id)}/ack`, { method: 'PATCH' }),

  closeAlert: (id: string): Promise<Record<string, unknown>> =>
    request(`/alerts/${encodeURIComponent(id)}/close`, { method: 'PATCH' }),

  alertStats: (): Promise<Record<string, number>> => request('/alerts/stats'),

  // ── 审计 ──
  auditVerify: (): Promise<{ ok: boolean; checked: number }> => request('/audit/verify'),

  // ── 用量 / 治理 / 交接班 ──
  usageSummary: (hours: number): Promise<Record<string, unknown>> =>
    request(`/usage/summary${query({ hours })}`),

  governanceReport: (hours: number): Promise<Record<string, unknown>> =>
    request(`/governance/report${query({ hours })}`),

  createHandover: (notes: string): Promise<Record<string, unknown>> =>
    request('/handover', { method: 'POST', body: JSON.stringify({ notes }) }),

  latestHandover: (): Promise<Record<string, unknown>> => request('/handover/latest'),

  // ── 运行时注册表 ──
  playbooks: (): Promise<{ playbooks: { name: string; description: string; mode: string; stepCount: number }[] }> => request('/playbooks'),

  analyzers: (): Promise<{ analyzers: { name: string; category: string; description: string; types: string[] }[] }> => request('/analyzers'),

  skills: (): Promise<{ skills: { name: string; description: string; file: string }[] }> => request('/skills'),

  plugins: (): Promise<{ plugins: { id: string; name: string; version: string; description: string | null; capabilities: string[]; enabled: boolean; source: string }[] }> => request('/plugins'),

  playbookRuns: (): Promise<{ runs: { runId: string; playbookName: string; mode: string; status: string; triggerType: string; triggerAlertId: string | undefined; startedAt: string; stepCount: number }[] }> => request('/playbook-runs'),

  triggerPlaybook: (name: string): Promise<Record<string, unknown>> =>
    request(`/playbooks/${encodeURIComponent(name)}/trigger`, { method: 'POST' }),

  baselines: (asset: string): Promise<{ baselines: { metric: string; p50: number; p95: number; sampleCount: number; computedAt: string }[] }> =>
    request(`/baselines/${encodeURIComponent(asset)}`),

  // ── 模型配置（key 只写不读）──
  models: (): Promise<{ models: { name: string; baseUrl: string; modelId: string; tier: string; enabled: boolean; lastUsedAt: string | undefined }[] }> => request('/models'),

  saveModel: (input: { name: string; baseUrl: string; modelId: string; apiKey: string; tier: 'cheap' | 'strong'; enabled: boolean }): Promise<Record<string, unknown>> =>
    request('/models', { method: 'POST', body: JSON.stringify(input) }),

  deleteModel: (name: string): Promise<Record<string, unknown>> =>
    request(`/models/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // ── 保险箱（值只写不读，列表只含尾4位 hint）──
  secrets: (): Promise<{ secrets: { id: string; name: string; hint: string; version: number; updatedAt: string }[] }> => request('/secrets'),

  setSecret: (name: string, value: string): Promise<{ secret: { id: string; name: string; hint: string; version: number; updatedAt: string } }> =>
    request('/secrets', { method: 'POST', body: JSON.stringify({ name, value }) }),

  // ── AI 巡查 ──
  patrollerStatus: (): Promise<Record<string, unknown>> => request('/patroller/status'),

  patrollerRun: (opts: { asset?: string; severity?: string } = {}): Promise<Record<string, unknown>> =>
    request('/patroller/run', { method: 'POST', body: JSON.stringify(opts) }),
};
