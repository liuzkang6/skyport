/**
 * 资产执行互斥（PRD 多人协作治理）：同一资产上有 executing 行动时，
 * 新行动进串行队列（拒绝创建），看板显示"操作进行中"徽章。
 * 同一台机器同一时刻只有一只手——防并发操作冲突。
 */
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';

export interface AssetMutexStatus {
  readonly assetName: string;
  readonly locked: boolean;
  readonly executingActionId: string | undefined;
  readonly executingCommand: string | undefined;
  readonly executingSince: string | undefined;
}

/** 检查资产是否被 executing 行动锁定 */
export function getAssetMutex(assetName: string): AssetMutexStatus {
  const row = getDb()
    .prepare(
      `SELECT id, command, updated_at FROM actions
       WHERE target_name = ? AND status IN ('approved', 'executing')
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(assetName) as { id: string; command: string; updated_at: string } | undefined;

  if (row === undefined) {
    return { assetName, locked: false, executingActionId: undefined, executingCommand: undefined, executingSince: undefined };
  }
  return { assetName, locked: true, executingActionId: row.id, executingCommand: row.command, executingSince: row.updated_at };
}

/** 行动创建前检查：资产被锁则拒绝（spec：v0.4 资产互斥） */
export function assertAssetNotLocked(assetName: string): void {
  const mutex = getAssetMutex(assetName);
  if (mutex.locked) {
    throw createError(
      ERROR_CODES.ACTION_INVALID_STATE,
      `资产 ${assetName} 上有操作进行中（${mutex.executingActionId}: ${mutex.executingCommand?.slice(0, 40)}），请等待完成后再发起`,
      { context: { assetName, lockingActionId: mutex.executingActionId, since: mutex.executingSince } },
    );
  }
}

/** 事件认领（PRD 多人协作）：事件/行动单有 assignee，认领后他人的提案挂"有人处理中"提示 */
export function claimAction(actionId: string, assignee: string): void {
  const result = getDb()
    .prepare('UPDATE actions SET assignee = ?, updated_at = ? WHERE id = ? AND assignee IS NULL')
    .run(assignee, new Date().toISOString(), actionId);
  if (result.changes === 0) {
    const existing = getDb().prepare('SELECT assignee FROM actions WHERE id = ?').get(actionId) as { assignee: string | null } | undefined;
    if (existing === undefined) {
      throw createError(ERROR_CODES.ACTION_NOT_FOUND, `行动不存在: ${actionId}`, { context: { actionId } });
    }
    throw createError(ERROR_CODES.ACTION_INVALID_STATE, `行动已被 ${existing.assignee} 认领`, {
      context: { actionId, currentAssignee: existing.assignee },
    });
  }
}

/** 释放认领（交接或放弃） */
export function releaseAction(actionId: string, currentAssignee: string): void {
  const result = getDb()
    .prepare('UPDATE actions SET assignee = NULL, updated_at = ? WHERE id = ? AND assignee = ?')
    .run(new Date().toISOString(), actionId, currentAssignee);
  if (result.changes === 0) {
    throw createError(ERROR_CODES.ACTION_INVALID_STATE, '释放认领失败（非当前认领人或不存在）', { context: { actionId } });
  }
}
