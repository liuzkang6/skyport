import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import {
  DISPATCHER_AGENT_NAME,
  dispatchAlertToPlaybooks,
  ensureDispatcherActor,
  graduationRecords,
  listPlaybookRuns,
  playbookMatchesAlert,
  triggerPlaybookByName,
} from './alert-dispatcher';
import { BUILTIN_PLAYBOOKS } from './playbook';
import { humanUserId, type ActorRef } from './agents';

let tempDir: string;
const HUMAN: ActorRef = { type: 'human', id: humanUserId(), name: humanUserId() };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-dispatch-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

function countRuns(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM playbook_runs').get() as { n: number }).n;
}

async function waitForRuns(expected: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countRuns() >= expected) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return countRuns() >= expected;
}

describe('告警闭环调度器（spec/alert-dispatcher）', () => {
  it('匹配：事件名精确/通配 + severity 门槛', () => {
    const diskCleanup = BUILTIN_PLAYBOOKS.find((p) => p.name === 'disk-cleanup')!;
    expect(playbookMatchesAlert(diskCleanup, { event: 'DiskFull', severity: 'critical' })).toBe(true);
    expect(playbookMatchesAlert(diskCleanup, { event: 'HighDiskUsage', severity: 'warning' })).toBe(true);
    // severity 低于门槛不触发
    expect(playbookMatchesAlert(diskCleanup, { event: 'DiskFull', severity: 'info' })).toBe(false);
    // 事件名不匹配
    expect(playbookMatchesAlert(diskCleanup, { event: 'CPUSpike', severity: 'critical' })).toBe(false);

    const serviceRestart = BUILTIN_PLAYBOOKS.find((p) => p.name === 'service-restart')!;
    // minSeverity=critical：warning 不够
    expect(playbookMatchesAlert(serviceRestart, { event: 'HTTP5xx', severity: 'warning' })).toBe(false);
    expect(playbookMatchesAlert(serviceRestart, { event: 'OOMKilled', severity: 'critical' })).toBe(true);
  });

  it('调度器系统 agent 首次使用自动开通，幂等', () => {
    const first = ensureDispatcherActor();
    expect(first.name).toBe(DISPATCHER_AGENT_NAME);
    expect(first.type).toBe('agent');
    const again = ensureDispatcherActor();
    expect(again.id).toBe(first.id);
  });

  it('自动触发：DiskFull 告警命中 disk-cleanup → vendored 引擎执行 → playbook_runs 落痕（training 零行动）', async () => {
    dispatchAlertToPlaybooks({ id: 'alt_test1', event: 'DiskFull', severity: 'critical', resource: 't1' });
    expect(await waitForRuns(1)).toBe(true);

    const runs = listPlaybookRuns();
    expect(runs[0]!.playbookName).toBe('disk-cleanup');
    expect(runs[0]!.triggerType).toBe('alert');
    expect(runs[0]!.triggerAlertId).toBe('alt_test1');
    // 触发者是系统调度器 agent（按 id 反查名字）
    expect(runs[0]!.triggeredBy).toMatch(/^agent:agt_/);
    const dispatcherId = runs[0]!.triggeredBy.split(':')[1] ?? '';
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(dispatcherId) as { name: string };
    expect(agentRow.name).toBe(DISPATCHER_AGENT_NAME);
    // 内置剧本 training 相：只记录不执行
    expect(runs[0]!.mode).toBe('training');
    expect(runs[0]!.status).toBe('completed');
    const actions = (getDb().prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number }).n;
    expect(actions).toBe(0);
  });

  it('冷却窗口：同剧本 5 分钟内第二次告警不重复触发', async () => {
    dispatchAlertToPlaybooks({ id: 'alt_a', event: 'DiskFull', severity: 'critical', resource: 't1' });
    expect(await waitForRuns(1)).toBe(true);
    dispatchAlertToPlaybooks({ id: 'alt_b', event: 'HighDiskUsage', severity: 'warning', resource: 't2' });
    await new Promise((r) => setTimeout(r, 300));
    expect(countRuns()).toBe(1); // 冷却跳过不落库
  });

  it('无命中：无关告警不触发任何剧本', async () => {
    dispatchAlertToPlaybooks({ id: 'alt_x', event: 'SomethingElse', severity: 'critical', resource: 't1' });
    await new Promise((r) => setTimeout(r, 200));
    expect(countRuns()).toBe(0);
  });

  it('手动触发：按名执行并留痕 trigger_type=manual', async () => {
    const result = await triggerPlaybookByName('service-restart', HUMAN);
    expect(result.mode).toBe('training');
    const runs = listPlaybookRuns();
    expect(runs[0]!.playbookName).toBe('service-restart');
    expect(runs[0]!.triggerType).toBe('manual');
    expect(runs[0]!.triggeredBy).toContain(HUMAN.id);
  });

  it('手动触发未知剧本 → 报错', async () => {
    await expect(triggerPlaybookByName('no-such-playbook', HUMAN)).rejects.toThrow('剧本不存在');
  });

  it('毕业统计：从 playbook_runs 汇总各相次数', async () => {
    await triggerPlaybookByName('disk-cleanup', HUMAN);
    await triggerPlaybookByName('disk-cleanup', HUMAN);
    await triggerPlaybookByName('disk-cleanup', HUMAN);
    const records = graduationRecords('disk-cleanup');
    const training = records.find((r) => r.mode === 'training');
    expect(training?.count).toBeGreaterThanOrEqual(3);
    expect(records.find((r) => r.mode === 'detect')?.count ?? 0).toBe(0);
  });
});
