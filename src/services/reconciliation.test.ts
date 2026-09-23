import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { createAction } from './actions';
import { reconcileZombies, ZOMBIE_THRESHOLD_MINUTES } from './reconciliation';
import { verifyAuditChain } from './audit-chain';
import { humanUserId, type ActorRef } from './agents';

let tempDir: string;
const HUMAN: ActorRef = { type: 'human', id: humanUserId(), name: humanUserId() };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-reconcile-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

/** 直改库模拟僵尸：状态推到 executing，updated_at 拨回到指定分钟前 */
function plantZombie(actionId: string, minutesAgo: number): void {
  const stale = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  getDb()
    .prepare("UPDATE actions SET status = 'executing', updated_at = ? WHERE id = ?")
    .run(stale, actionId);
}

function getStatus(actionId: string): string {
  const row = getDb().prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
  return row.status;
}

describe('僵尸对账（v0.3.x 网关完工线）', () => {
  it('超时 executing 行动被标记 failed，审计链写入 zombie-reconciled 且 verify 通过', async () => {
    const { action } = await createAction({
      command: 'echo hello',
      reason: '测试僵尸对账',
      riskHint: 'low',
      actor: HUMAN,
    });
    plantZombie(action.id, ZOMBIE_THRESHOLD_MINUTES + 5);

    const report = reconcileZombies();

    expect(report.reconciled).toBe(1);
    expect(report.actionIds).toContain(action.id);
    expect(getStatus(action.id)).toBe('failed');
    const events = getDb()
      .prepare('SELECT event, actor_type, actor_id FROM action_events WHERE action_id = ? ORDER BY id')
      .all(action.id) as { event: string; actor_type: string; actor_id: string }[];
    const zombie = events.find((e) => e.event === 'zombie-reconciled');
    expect(zombie?.actor_type).toBe('system');
    expect(zombie?.actor_id).toBe('skyport-reconciler');
    expect(verifyAuditChain().ok).toBe(true);
  });

  it('未超阈值的 executing 行动不被误杀', async () => {
    const { action } = await createAction({
      command: 'echo fresh',
      reason: '测试不误杀',
      riskHint: 'low',
      actor: HUMAN,
    });
    plantZombie(action.id, ZOMBIE_THRESHOLD_MINUTES - 5); // 10 分钟前：仍在途

    const report = reconcileZombies();

    expect(report.scanned).toBe(0);
    expect(getStatus(action.id)).toBe('executing');
  });

  it('非 executing 状态（如 pending）不受对账影响', async () => {
    const { action } = await createAction({
      command: 'echo pending',
      reason: '测试范围限定',
      riskHint: 'low',
      actor: HUMAN,
    });

    const report = reconcileZombies();

    expect(report.reconciled).toBe(0);
    expect(getStatus(action.id)).toBe('pending');
  });

  it('行动恰好在对账瞬间收敛终态时不产生双重终态（claimTransition 让位）', async () => {
    const { action } = await createAction({
      command: 'echo race',
      reason: '测试竞态让位',
      riskHint: 'low',
      actor: HUMAN,
    });
    plantZombie(action.id, ZOMBIE_THRESHOLD_MINUTES + 5);
    // 模拟执行进程抢先写入终态
    getDb().prepare("UPDATE actions SET status = 'success' WHERE id = ?").run(action.id);

    const report = reconcileZombies();

    expect(report.reconciled).toBe(0);
    expect(getStatus(action.id)).toBe('success');
    const events = getDb()
      .prepare("SELECT COUNT(*) AS n FROM action_events WHERE action_id = ? AND event = 'zombie-reconciled'")
      .get(action.id) as { n: number };
    expect(events.n).toBe(0);
  });

  it('自定义阈值生效：1 分钟阈值能收割刚超时的行动', async () => {
    const { action } = await createAction({
      command: 'echo quick',
      reason: '测试自定义阈值',
      riskHint: 'low',
      actor: HUMAN,
    });
    plantZombie(action.id, 2);

    const report = reconcileZombies(1);

    expect(report.reconciled).toBe(1);
    expect(getStatus(action.id)).toBe('failed');
  });
});
