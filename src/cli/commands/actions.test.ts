import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../adapters/db';
import { resetConfigCache } from '../../config/config';
import { createError, ERROR_CODES, isSkyportError } from '../../errors/errors';
import type { ActionResult } from '../../services/actions';
import { buildActionCommand, buildBatchError, executionFailureOf } from './actions';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-cli-actions-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

function resultWithStatus(status: string): ActionResult {
  return {
    action: {
      id: 'act_test0001',
      command: 'ls /nope',
      targetAssetId: undefined,
      targetName: 'local',
      targetKind: 'local',
      reason: undefined,
      rollback: undefined,
      riskLevel: 'low',
      riskSource: 'default-low',
      status: status as ActionResult['action']['status'],
      actorType: 'human',
      actorId: 'liu',
      actorName: undefined,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    },
    execution:
      status === 'failed'
        ? {
            id: 1,
            actionId: 'act_test0001',
            ok: false,
            stdout: '',
            stderr: 'No such file',
            exitCode: 2,
            timedOut: false,
            durationMs: 12,
            attempts: 1,
            stdoutTruncated: false,
            stderrTruncated: false,
            error: 'SKYPORT_EXEC_NON_ZERO: 命令以非零退出码结束',
            createdAt: '2026-09-22T00:00:01.000Z',
          }
        : undefined,
  };
}

describe('CLI 退出码契约（红队 S7/S8）', () => {
  it('executionFailureOf：行动 failed → EXEC_NON_ZERO（exit 4）；成功/待审批不报错', () => {
    const failure = executionFailureOf(resultWithStatus('failed'));
    expect(isSkyportError(failure)).toBe(true);
    if (isSkyportError(failure)) expect(failure.type).toBe('SKYPORT_EXEC_NON_ZERO');
    expect(executionFailureOf(resultWithStatus('success'))).toBeUndefined();
    expect(executionFailureOf(resultWithStatus('pending'))).toBeUndefined();
  });

  it('buildBatchError：保留第一条真实域码（不再出现"未知错误"语义）', () => {
    const stateError = buildBatchError(
      [createError(ERROR_CODES.ACTION_INVALID_STATE, '行动状态冲突', { context: { actionId: 'act_x' } })],
      0,
      2,
    );
    expect(isSkyportError(stateError)).toBe(true);
    if (isSkyportError(stateError)) {
      expect(stateError.type).toBe('SKYPORT_ACTION_INVALID_STATE');
      expect(stateError.message).toContain('1/2');
    }
  });

  it('buildBatchError：纯执行失败汇总为 EXEC 域；无失败返回 undefined', () => {
    const execError = buildBatchError([], 2, 3);
    expect(isSkyportError(execError)).toBe(true);
    if (isSkyportError(execError)) expect(execError.type).toBe('SKYPORT_EXEC_NON_ZERO');
    expect(buildBatchError([], 0, 3)).toBeUndefined();
  });
});


// ── 红队 V4：护栏旗标 CLI 接线（--rollback / --dry-run）──

describe('action create 护栏旗标（spec/guardrails）', () => {
  async function runCreate(args: string[]): Promise<unknown> {
    const prog = new Command().exitOverride(); // 测试内不真退出
    prog.addCommand(buildActionCommand());
    return prog.parseAsync(['node', 'skyport', 'action', ...args]);
  }

  it('high 无 --rollback → 拒绝（域码 ACTION_INVALID）；带 --rollback → 登记 pending', async () => {
    await expect(runCreate(['create', '--exec', 'shutdown now'])).rejects.toThrowError();
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number };
    expect(rows.n).toBe(0);

    await runCreate(['create', '--exec', 'shutdown now', '--rollback', '重启机器即可']);
    const saved = getDb().prepare('SELECT rollback, status FROM actions').get() as { rollback: string; status: string };
    expect(saved.rollback).toBe('重启机器即可');
    expect(saved.status).toBe('pending');
  });

  it('--dry-run：只评级不落库（high 也无需 rollback）', async () => {
    await runCreate(['create', '--exec', 'shutdown now', '--dry-run']);
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
