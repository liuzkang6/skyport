import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import {
  appendChainedEvent,
  appendChainedExecution,
  computeChainHash,
  isActionEventType,
  verifyAuditChain,
} from './audit-chain';

let tempDir: string;

function seedAction(actionId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO actions (id, command, target_name, target_kind, risk_level, risk_source, status, actor_type, actor_id, created_at, updated_at)
       VALUES (?, 'echo test', 'local', 'local', 'low', 'default-low', 'success', 'agent', 'agt_test', ?, ?)`,
    )
    .run(actionId, now, now);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-audit-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
  getDb(); // 触发建库建表
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('审计链防篡改（spec/audit-chain）', () => {
  it('事件名枚举：合法值通过，拼错值拒绝', () => {
    expect(isActionEventType('created')).toBe(true);
    expect(isActionEventType('approved')).toBe(true);
    expect(isActionEventType('aproved')).toBe(false);
  });

  it('链式哈希：相同内容不同前驱产生不同哈希', () => {
    const a = computeChainHash(null, { x: 1 });
    const b = computeChainHash('abc', { x: 1 });
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
  });

  it('正常链路：写入多条事件+执行后 verify 通过', () => {
    seedAction('act_a');
    appendChainedEvent('act_a', 'created', 'agent', 'agt_1', { risk: 'low' });
    appendChainedEvent('act_a', 'approved', 'human', 'liu');
    appendChainedExecution('act_a', { ok: true, stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, durationMs: 12, attempts: 1, error: null });
    const result = verifyAuditChain();
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(3);
  });

  it('篡改检测：删一条事件后 verify 报断链', () => {
    seedAction('act_b');
    appendChainedEvent('act_b', 'created', 'agent', 'agt_1');
    appendChainedEvent('act_b', 'approved', 'human', 'liu');
    appendChainedEvent('act_b', 'exec-started', 'human', 'liu');
    // 直改库删中间一条
    getDb().prepare("DELETE FROM action_events WHERE event = 'approved'").run();
    const result = verifyAuditChain();
    expect(result.ok).toBe(false);
    expect(result.firstViolation).toBeDefined();
  });

  it('篡改检测：改一条事件内容后 verify 报 hash 不匹配', () => {
    seedAction('act_c');
    appendChainedEvent('act_c', 'created', 'agent', 'agt_1');
    appendChainedEvent('act_c', 'approved', 'human', 'liu');
    // 链完整后直改库改第一条的 hash（模拟事后篡改）
    const fakeHash = '0'.repeat(64);
    getDb().prepare("UPDATE action_events SET hash = ? WHERE event = 'created'").run(fakeHash);
    const result = verifyAuditChain();
    expect(result.ok).toBe(false);
  });

  it('空表 verify：输出无记录可校验', () => {
    const result = verifyAuditChain();
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
  });
});
