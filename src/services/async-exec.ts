/**
 * 执行异步化 + 结果回推（PRD v0.3.x）：approve 立即返回"已放行"，
 * 命令在后台执行，结果落审计 + 通过 webhook 回推。
 */
import { httpRequest } from '../adapters/http';
import { getConfig } from '../config/config';
import { rootLogger } from '../logger/logger';
import { executeAction } from './action-exec';
import type { Action } from './actions';

export interface AsyncExecHandle {
  readonly actionId: string;
  readonly started: boolean;
}

/** 异步放行执行：立即返回，后台跑命令，完成后回推 webhook */
export function approveAsync(action: Action, actor: { type: 'human' | 'agent'; id: string }): AsyncExecHandle {
  const config = getConfig();
  const webhookUrl = (config as unknown as { notifyWebhookUrl?: string }).notifyWebhookUrl;

  // 后台执行（不阻塞 approve 返回）
  setImmediate(() => {
    void runInBackground(action, actor, webhookUrl);
  });

  return { actionId: action.id, started: true };
}

async function runInBackground(
  action: Action,
  actor: { type: 'human' | 'agent'; id: string },
  webhookUrl: string | undefined,
): Promise<void> {
  try {
    const result = await executeAction(action, actor);
    rootLogger.info('异步执行完成', { actionId: action.id, ok: result.ok });
    if (webhookUrl !== undefined) {
      await pushResult(webhookUrl, action, result);
    }
  } catch (error) {
    rootLogger.error('异步执行失败', { actionId: action.id, error: error instanceof Error ? error.message : String(error) });
    if (webhookUrl !== undefined) {
      await pushResult(webhookUrl, action, undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

async function pushResult(
  url: string,
  action: Action,
  execution: unknown,
  errorMessage?: string,
): Promise<void> {
  const payload = {
    event: 'skyport.action.executed',
    actionId: action.id,
    command: action.command,
    status: errorMessage !== undefined ? 'error' : 'completed',
    error: errorMessage ?? null,
    execution,
    timestamp: new Date().toISOString(),
  };
  try {
    await httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 5_000,
    });
  } catch (error) {
    rootLogger.warn('结果回推失败（不阻断）', { url, error: error instanceof Error ? error.message : String(error) });
  }
}
