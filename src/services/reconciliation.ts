/**
 * 僵尸对账（PRD v0.3.x 网关完工线遗留项）：
 * 进程崩溃/断电/网络分区会让行动永远停在 executing——状态机必须能自愈。
 * - 扫描 updated_at 早于阈值的 executing 行动，原子迁移到 failed（复用 claimTransition 的占位语义）
 * - 每条对账都写链化审计事件，`audit verify` 可见
 * - 事件枚举新增 'zombie-reconciled'：与人为失败区分，事后可统计网关崩溃率
 * 阈值取保守值（15 分钟）：executor 超时上限 10s + 3 次重试，正常执行远到不了分钟级；
 * 对账是"兜底"不是"抢跑"，宁可晚标记也不误杀在途执行。
 */
import { getDb } from '../adapters/db';
import { rootLogger } from '../logger/logger';
import { claimTransition } from './action-exec';
import { appendChainedEvent } from './audit-chain';

export const ZOMBIE_THRESHOLD_MINUTES = 15;

export interface ZombieReport {
  readonly scanned: number;
  readonly reconciled: number;
  readonly actionIds: readonly string[];
}

interface ExecutingRow {
  id: string;
  updated_at: string;
}

/**
 * 对账一次：把超时 executing 行动标记为 failed。
 * 原子性：claimTransition 只在行动仍处于 executing 时迁移——若执行进程恰好在此刻
 * 写入终态，对账会让位（changes=0），不产生双重终态。
 */
export function reconcileZombies(
  thresholdMinutes: number = ZOMBIE_THRESHOLD_MINUTES,
  now: Date = new Date(),
): ZombieReport {
  const cutoff = new Date(now.getTime() - thresholdMinutes * 60_000).toISOString();
  const rows = getDb()
    .prepare("SELECT id, updated_at FROM actions WHERE status = 'executing' AND updated_at < ?")
    .all(cutoff) as ExecutingRow[];
  const reconciled: string[] = [];
  for (const row of rows) {
    if (claimTransition(row.id, 'executing', 'failed')) {
      appendChainedEvent(
        row.id,
        'zombie-reconciled',
        'system',
        'skyport-reconciler',
        { thresholdMinutes, staleSince: row.updated_at, reason: 'executing 超时未收敛，判定为僵尸行动' },
      );
      reconciled.push(row.id);
    }
  }
  if (reconciled.length > 0) {
    rootLogger.warn('僵尸对账：标记超时执行中行动为失败', { count: reconciled.length, actionIds: reconciled });
  }
  return { scanned: rows.length, reconciled: reconciled.length, actionIds: reconciled };
}
