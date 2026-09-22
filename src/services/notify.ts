/**
 * 出站通知（M3，spec/governance-ux/spec.md）：pending 行动产生时向通用 webhook 发一条 JSON。
 * 治理原则：通知是尽力而为——未配置不发、发送失败只记 WARN，绝不阻断行动创建。
 */
import { httpRequest } from '../adapters/http';
import { getConfig } from '../config/config';
import { rootLogger } from '../logger/logger';
import type { Action } from './actions';

/** 通知超时：宁可丢通知也不能让高危审批流程卡 5 秒以上 */
const NOTIFY_TIMEOUT_MS = 5_000;

/** 凭据遮蔽（红队 S6：命令里的密码/token 不出站，默认开启） */
const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /(-p|--password(?:\s|=)?|--passwd(?:\s|=)?)\s*\S+/gi, replacement: '$1 ***' },
  { pattern: /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\b["']?\s*[=:]\s*\S+/gi, replacement: '$1=***' },
  { pattern: /skp_[0-9a-f]{32}/gi, replacement: 'skp_***' },
  { pattern: /\bBearer\s+\S+/gi, replacement: 'Bearer ***' },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export interface PendingActionPayload {
  readonly event: 'skyport.action.pending';
  readonly actionId: string;
  readonly command: string;
  readonly riskLevel: string;
  readonly target: string;
  readonly actor: string;
  readonly reason: string | undefined;
  readonly hint: string;
  readonly redacted: boolean;
}

export function buildPendingPayload(action: Action): PendingActionPayload {
  const command = redactSecrets(action.command);
  return {
    event: 'skyport.action.pending',
    actionId: action.id,
    command,
    riskLevel: action.riskLevel,
    target: action.targetKind === 'local' ? 'local' : action.targetName,
    actor: `${action.actorType}:${action.actorId}`,
    reason: action.reason,
    hint: `skyport approve ${action.id} / skyport reject ${action.id}`,
    redacted: command !== action.command,
  };
}

/** 返回是否成功送达；未配置返回 false（静默） */
export async function notifyPendingAction(action: Action): Promise<boolean> {
  const url = getConfig().notifyWebhookUrl;
  if (url === undefined) return false;
  try {
    const response = await httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPendingPayload(action)),
      timeoutMs: NOTIFY_TIMEOUT_MS,
    });
    if (response.status >= 400) {
      rootLogger.warn('webhook 通知返回非 2xx（不阻断治理流程）', { url, status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rootLogger.warn('webhook 通知发送失败（不阻断治理流程）', { url, error: message });
    return false;
  }
}
