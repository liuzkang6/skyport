import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { addAsset } from './assets';
import { claimAction, getAssetMutex, assertAssetNotLocked, releaseAction } from './asset-mutex';
import { humanUserId, type ActorRef } from './agents';
import { createAction } from './actions';

let tempDir: string;
const HUMAN: ActorRef = { type: 'human', id: humanUserId(), name: humanUserId() };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-mutex-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

function cap(fn: () => unknown): string {
  try { fn(); } catch (e) { if (isSkyportError(e)) return e.type; throw e; }
  throw new Error('应抛错');
}

/** 直改库模拟 executing 状态（approveAction 是同步执行的，测试用直改更可靠） */
function setActionStatus(actionId: string, status: string): void {
  getDb().prepare('UPDATE actions SET status = ? WHERE id = ?').run(status, actionId);
}

describe('资产执行互斥 + 事件认领（v0.4 多人协作）', () => {
  it('正常路径：无操作时资产未锁定', () => {
    addAsset({ name: 'free', type: 'host', addr: '10.0.0.1' });
    const mutex = getAssetMutex('free');
    expect(mutex.locked).toBe(false);
    assertAssetNotLocked('free'); // 不抛错
  });

  it('互斥：executing 行动锁定资产，新行动被拒', async () => {
    addAsset({ name: 'locked', type: 'host', addr: '10.0.0.2' });
    const created = await createAction({ command: 'systemctl restart nginx', actor: HUMAN, target: 'locked' });
    // 模拟执行中状态
    setActionStatus(created.action.id, 'executing');

    const mutex = getAssetMutex('locked');
    expect(mutex.locked).toBe(true);
    expect(mutex.executingActionId).toBe(created.action.id);
    expect(cap(() => assertAssetNotLocked('locked'))).toBe('SKYPORT_ACTION_INVALID_STATE');
  });

  it('解锁：行动到终态后资产恢复可用', async () => {
    addAsset({ name: 'cycle', type: 'host', addr: '10.0.0.3' });
    const created = await createAction({ command: 'echo done', actor: HUMAN, target: 'cycle' });
    setActionStatus(created.action.id, 'executing');
    expect(getAssetMutex('cycle').locked).toBe(true);

    setActionStatus(created.action.id, 'success');
    expect(getAssetMutex('cycle').locked).toBe(false);
    assertAssetNotLocked('cycle'); // 不抛错
  });

  it('事件认领：claim 后他人不能再 claim', async () => {
    const created = await createAction({ command: 'echo test', actor: HUMAN });
    claimAction(created.action.id, 'alice');
    expect(cap(() => claimAction(created.action.id, 'bob'))).toBe('SKYPORT_ACTION_INVALID_STATE');
  });

  it('事件认领：释放后可再 claim', async () => {
    const created = await createAction({ command: 'echo test', actor: HUMAN });
    claimAction(created.action.id, 'alice');
    releaseAction(created.action.id, 'alice');
    claimAction(created.action.id, 'bob'); // 不抛错
  });

  it('失败路径：claim 不存在的行动 → ACTION_NOT_FOUND', () => {
    expect(cap(() => claimAction('ghost', 'alice'))).toBe('SKYPORT_ACTION_NOT_FOUND');
  });
});
