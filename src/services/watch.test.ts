import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { approveAction, createAction } from './actions';
import { humanUserId, type ActorRef } from './agents';
import { pollPending } from './watch';

let tempDir: string;
const HUMAN: ActorRef = { type: 'human', id: humanUserId(), name: humanUserId() };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-watch-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('watch 值守增量计算', () => {
  it('空库：fresh 与 resolved 均为空', () => {
    const diff = pollPending(new Set());
    expect(diff.fresh).toHaveLength(0);
    expect(diff.resolved).toHaveLength(0);
    expect(diff.currentPendingIds).toHaveLength(0);
  });

  it('新 pending 被识别为 fresh；重复轮询不再重复提醒', async () => {
    const created = await createAction({ command: 'systemctl restart nginx', actor: HUMAN });
    const first = pollPending(new Set());
    expect(first.fresh.map((action) => action.id)).toEqual([created.action.id]);
    const second = pollPending(new Set(first.currentPendingIds));
    expect(second.fresh).toHaveLength(0);
    expect(second.resolved).toHaveLength(0);
  });

  it('已见行动离开 pending → resolved 携带终态', async () => {
    const created = await createAction({ command: 'node -e "0"', actor: HUMAN });
    const seen = new Set(pollPending(new Set()).currentPendingIds);
    await approveAction(created.action.id, HUMAN);
    const diff = pollPending(seen);
    expect(diff.fresh).toHaveLength(0);
    expect(diff.resolved).toEqual([{ id: created.action.id, status: 'success' }]);
  });
});
