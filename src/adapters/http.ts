/**
 * 网络请求适配器 —— 全项目唯一的网络出口（AGENTS.md §4）。
 * 业务代码禁止直接调 fetch；所有异常归一化为 SKYPORT_NETWORK_* 错误码再上抛。
 */
import { createError, ERROR_CODES } from '../errors/errors';

/** 适配器自身默认超时；可被调用方覆盖（CLI 场景的默认值，不进全局配置） */
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export interface HttpRequestOptions {
  readonly method?: 'GET' | 'POST' | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly durationMs: number;
}

/** AbortSignal.timeout 触发的是 TimeoutError；undici 有时会包一层 cause，沿链找 */
function isTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if (current.name === 'TimeoutError' || current.name === 'AbortError') return true;
    current = current.cause;
  }
  return false;
}

export async function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const startedAt = performance.now();
  // exactOptionalPropertyTypes：不显式传 undefined 给 RequestInit 的可选属性
  const init: RequestInit = { signal: AbortSignal.timeout(timeoutMs) };
  if (options.method !== undefined) init.method = options.method;
  if (options.headers !== undefined) init.headers = options.headers;
  if (options.body !== undefined) init.body = options.body;

  try {
    const response = await fetch(url, init);
    const body = await response.text();
    // 非 2xx 不在适配器层抛错：状态码如实返回，由业务决定语义
    return { status: response.status, body, durationMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    if (isTimeoutError(error)) {
      throw createError(ERROR_CODES.NETWORK_TIMEOUT, `请求超时（${timeoutMs}ms）: ${url}`, {
        cause: error,
        context: { url, timeoutMs },
      });
    }
    throw createError(ERROR_CODES.NETWORK_REQUEST_FAILED, `请求失败: ${url}`, {
      cause: error,
      context: { url },
    });
  }
}
