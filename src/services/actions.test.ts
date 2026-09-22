import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { addAsset } from './assets';
import {
  approveAction,
  cancelAction,
  createAction,
  getAction,
  getActionEvents,
  agentRun,
  listActions,
  rejectAction,
  runDirect,
} from './actions';
import { createAgent, humanUserId, type ActorRef } from './agents';

let tempDir: string;

const HUMAN: ActorRef = { type: 'human', id: humanUserId(), name: humanUserId() };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-actions-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  // 策略文件按 cwd 解析：测试进程 cwd 没有 skyport.policy.json，默认策略生效
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

async function captureActionError(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isSkyportError(error)) return error.type;
    throw error;
  }
  throw new Error('期望抛出行动错误，但它正常返回了');
}

function safeCommand(): string {
  return `node -e "process.stdout.write('governed-ok')"`;
}

describe('actions 行动状态机与治理', () => {
  it('正常路径：human 登记中危命令 → pending + created 事件；低危（无策略开关）同样 pending', async () => {
    const medium = await createAction({ command: 'systemctl restart nginx', actor: HUMAN, reason: '内存泄漏' });
    expect(medium.action.status).toBe('pending');
    expect(medium.action.riskLevel).toBe('medium');
    expect(medium.execution).toBeUndefined();
    const events = getActionEvents(medium.action.id).map((event) => event.event);
    expect(events).toEqual(['created']);

    const low = await createAction({ command: safeCommand(), actor: HUMAN });
    expect(low.action.status).toBe('pending'); // 默认策略 autoExecLowRisk=false
    expect(low.action.riskLevel).toBe('low');
  });

  it('正常路径：approve 放行并立即执行 → success，事件链与执行记录完整', async () => {
    const created = await createAction({ command: safeCommand(), actor: HUMAN });
    const result = await approveAction(created.action.id, HUMAN);
    expect(result.action.status).toBe('success');
    expect(result.execution?.ok).toBe(true);
    expect(result.execution?.stdout).toBe('governed-ok');
    expect(result.execution?.exitCode).toBe(0);
    const events = getActionEvents(created.action.id).map((event) => event.event);
    expect(events).toEqual(['created', 'approved', 'exec-started', 'exec-finished']);
  });

  it('失败路径-执行失败是数据：命令非零退出 → failed + executions 留痕', async () => {
    const created = await createAction({ command: 'node -e "process.exit(3)"', actor: HUMAN });
    const result = await approveAction(created.action.id, HUMAN);
    expect(result.action.status).toBe('failed');
    expect(result.execution?.ok).toBe(false);
    expect(result.execution?.exitCode).toBe(3);
  });

  it('失败路径-状态机：对非 pending 行动 approve/reject/cancel → ACTION_INVALID_STATE', async () => {
    const created = await createAction({ command: safeCommand(), actor: HUMAN });
    await approveAction(created.action.id, HUMAN);
    expect(await captureActionError(() => approveAction(created.action.id, HUMAN))).toBe('SKYPORT_ACTION_INVALID_STATE');
    expect(await captureActionError(() => rejectAction(created.action.id, HUMAN))).toBe('SKYPORT_ACTION_INVALID_STATE');
    expect(await captureActionError(() => cancelAction(created.action.id, HUMAN))).toBe('SKYPORT_ACTION_INVALID_STATE');
  });

  it('正常路径：reject / cancel 落终态并留事件（带 note）', async () => {
    const toReject = await createAction({ command: 'shutdown now', actor: HUMAN });
    const rejected = rejectAction(toReject.action.id, HUMAN, '太危险');
    expect(rejected.status).toBe('rejected');
    const toCancel = await createAction({ command: safeCommand(), actor: HUMAN });
    expect(cancelAction(toCancel.action.id, HUMAN).status).toBe('cancelled');
    const rejectEvents = getActionEvents(toReject.action.id).map((event) => event.event);
    expect(rejectEvents).toEqual(['created', 'rejected']);
  });

  it('治理红线：agent actor 不能 approve/reject/cancel/run', async () => {
    const issued = createAgent({ name: 'zcode', assetPatterns: ['*'], riskCeiling: 'high', autoExecLow: false });
    const agentActor: ActorRef = { type: 'agent', id: issued.agent.id, name: issued.agent.name };
    const created = await createAction({ command: safeCommand(), actor: HUMAN });
    expect(await captureActionError(() => approveAction(created.action.id, agentActor))).toBe('SKYPORT_PERMISSION_DENIED');
    expect(await captureActionError(() => rejectAction(created.action.id, agentActor))).toBe('SKYPORT_PERMISSION_DENIED');
    expect(await captureActionError(() => cancelAction(created.action.id, agentActor))).toBe('SKYPORT_PERMISSION_DENIED');
    expect(await captureActionError(() => runDirect({ command: safeCommand(), actor: agentActor }))).toBe(
      'SKYPORT_PERMISSION_DENIED',
    );
  });

  it('agent 三件套：风险超限 / 资产不在范围 → 门口拒绝且不留行动记录', async () => {
    const issued = createAgent({ name: 'limited', assetPatterns: ['prod-web-*'], riskCeiling: 'low', autoExecLow: false });
    const actor: ActorRef = { type: 'agent', id: issued.agent.id, name: issued.agent.name };
    expect(await captureActionError(() => createAction({ command: 'systemctl restart nginx', actor }))).toBe(
      'SKYPORT_PERMISSION_DENIED',
    );
    addAsset({ name: 'db-01', type: 'host', addr: '10.0.2.10' });
    expect(
      await captureActionError(() => createAction({ command: safeCommand(), actor, target: 'db-01' })),
    ).toBe('SKYPORT_PERMISSION_DENIED');
    expect(listActions()).toHaveLength(0);
  });

  it('agent run：等待超时如实返回 pending；human 身份调用被拒', async () => {
    const issued = createAgent({ name: 'waiter', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const actor: ActorRef = { type: 'agent', id: issued.agent.id, name: issued.agent.name };
    const result = await agentRun({ command: 'systemctl restart nginx', actor }, 1_100);
    expect(result.action.status).toBe('pending');
    expect(result.execution).toBeUndefined();
    expect(await captureActionError(() => agentRun({ command: safeCommand(), actor: HUMAN }, 100))).toBe(
      'SKYPORT_PERMISSION_DENIED',
    );
  });

  it('正常路径：run 直通（human）免审批执行并留痕；action list 按状态过滤', async () => {
    const result = await runDirect({ command: safeCommand(), actor: HUMAN, reason: '人肉直通' });
    expect(result.action.status).toBe('success');
    const events = getActionEvents(result.action.id).map((event) => event.event);
    expect(events).toEqual(['created', 'direct-run', 'exec-started', 'exec-finished']);
    expect(listActions('success').map((action) => action.id)).toContain(result.action.id);
  });

  it('失败路径-输入校验：空命令 / 引号未闭合 / 超长命令 / 云账户目标', async () => {
    expect(await captureActionError(() => createAction({ command: '   ', actor: HUMAN }))).toBe('SKYPORT_ACTION_INVALID');
    expect(await captureActionError(() => createAction({ command: 'echo "x', actor: HUMAN }))).toBe('SKYPORT_ACTION_INVALID');
    expect(
      await captureActionError(() => createAction({ command: 'a'.repeat(2_001), actor: HUMAN })),
    ).toBe('SKYPORT_ACTION_INVALID');
    addAsset({ name: 'cloud-1', type: 'cloud-account' });
    expect(
      await captureActionError(() => createAction({ command: safeCommand(), actor: HUMAN, target: 'cloud-1' })),
    ).toBe('SKYPORT_ACTION_INVALID');
  });

  it('失败路径-SSH 目标不可达：行动 failed + 错误留痕（连接拒绝是数据不是异常）', async () => {
    addAsset({ name: 'ssh-target', type: 'host', addr: '127.0.0.1:1', connectMode: 'ssh' });
    const created = await createAction({ command: 'echo hi', actor: HUMAN, target: 'ssh-target' });
    expect(created.action.targetKind).toBe('ssh');
    const result = await approveAction(created.action.id, HUMAN);
    expect(result.action.status).toBe('failed');
    expect(result.execution?.ok).toBe(false);
    expect(result.execution?.error).toBeTruthy();
  });

  it('hint 只升不降贯穿行动记录：low 命令 + high hint → 行动风险 high', async () => {
    const created = await createAction({ command: safeCommand(), actor: HUMAN, riskHint: 'high' });
    expect(created.action.riskLevel).toBe('high');
    expect(getAction(created.action.id).riskSource).toBe('default-low');
  });
});
