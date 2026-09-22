import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { buildPendingPayload, notifyPendingAction } from './notify';
import { createAction, approveAction } from './actions';
import { humanUserId, type ActorRef } from './agents';
import type { Action } from './actions';

let tempDir: string;
const servers: Server[] = [];
const HUMAN: ActorRef = { type: 'human', id: humanUserId(), name: humanUserId() };

function sampleAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 'act_test0001',
    command: 'systemctl restart nginx',
    targetAssetId: undefined,
    targetName: 'local',
    targetKind: 'local',
    reason: '演练',
    riskLevel: 'medium',
    riskSource: 'builtin-rule',
    status: 'pending',
    actorType: 'agent',
    actorId: 'agt_test001',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

async function listenCapture(): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      bodies.push(raw);
      res.end('ok');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}/hook`, bodies };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-notify-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  delete process.env.SKYPORT_NOTIFY_WEBHOOK_URL;
  resetConfigCache();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  await rm(tempDir, { recursive: true, force: true });
});

describe('notify 出站通知', () => {
  it('payload 结构：event/actionId/command/risk/actor/hint 齐全', () => {
    const payload = buildPendingPayload(sampleAction());
    expect(payload.event).toBe('skyport.action.pending');
    expect(payload.actionId).toBe('act_test0001');
    expect(payload.command).toBe('systemctl restart nginx');
    expect(payload.riskLevel).toBe('medium');
    expect(payload.actor).toBe('agent:agt_test001');
    expect(payload.hint).toContain('skyport approve act_test0001');
  });

  it('未配置 webhook：不发送，返回 false', async () => {
    expect(await notifyPendingAction(sampleAction())).toBe(false);
  });

  it('正常路径：配置后 POST JSON 送达（钉钉/飞书/Slack incoming webhook 同构）', async () => {
    const capture = await listenCapture();
    process.env.SKYPORT_NOTIFY_WEBHOOK_URL = capture.url;
    resetConfigCache();
    expect(await notifyPendingAction(sampleAction())).toBe(true);
    expect(capture.bodies).toHaveLength(1);
    expect(JSON.parse(capture.bodies[0] ?? '{}')).toMatchObject({ event: 'skyport.action.pending', actionId: 'act_test0001' });
  });

  it('失败路径-不可达：发送失败不抛错（治理流程不被通知拖垮），返回 false', async () => {
    process.env.SKYPORT_NOTIFY_WEBHOOK_URL = 'http://127.0.0.1:1/nope';
    resetConfigCache();
    expect(await notifyPendingAction(sampleAction())).toBe(false);
  });

  it('集成：创建 pending 行动自动触发通知；自动执行/审批路径不触发', async () => {
    const capture = await listenCapture();
    process.env.SKYPORT_NOTIFY_WEBHOOK_URL = capture.url;
    resetConfigCache();
    const pending = await createAction({ command: 'systemctl restart nginx', actor: HUMAN });
    expect(pending.action.status).toBe('pending');
    expect(capture.bodies).toHaveLength(1);
    // 审批后没有新的通知（只在创建时通知一次）
    await approveAction(pending.action.id, HUMAN);
    expect(capture.bodies).toHaveLength(1);
  });
});
