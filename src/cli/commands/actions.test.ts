import { describe, expect, it } from 'vitest';
import { createError, ERROR_CODES, isSkyportError } from '../../errors/errors';
import type { ActionResult } from '../../services/actions';
import { buildBatchError, executionFailureOf } from './actions';

function resultWithStatus(status: string): ActionResult {
  return {
    action: {
      id: 'act_test0001',
      command: 'ls /nope',
      targetAssetId: undefined,
      targetName: 'local',
      targetKind: 'local',
      reason: undefined,
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
