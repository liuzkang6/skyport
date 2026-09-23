import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import {
  BUILTIN_PLAYBOOKS,
  canGraduate,
  executePlaybook,
  type GraduationRecord,
  type PlaybookDefinition,
} from './playbook';
import { humanUserId, type ActorRef } from './agents';

let tempDir: string;
const HUMAN: ActorRef = { type: 'human', id: humanUserId(), name: humanUserId() };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-pb-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  // detect 模式需要低危自动执行策略
  const policyFile = join(tempDir, 'skyport.policy.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(policyFile, JSON.stringify({ autoExecLowRisk: true }));
  process.env.SKYPORT_POLICY_PATH = policyFile;
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  delete process.env.SKYPORT_POLICY_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

const simplePlaybook: PlaybookDefinition = {
  name: 'test-playbook',
  description: '测试剧本',
  trigger: { alertEvents: ['TestAlert'] },
  mode: 'detect',
  steps: [
    { id: 's1', type: 'check', command: 'echo check-ok', description: '检查', onFailure: 'abort' },
    { id: 's2', type: 'notify', notifyMessage: 'done', description: '通知', onFailure: 'continue' },
  ],
};

describe('编排引擎（v0.6 受治理剧本）', () => {
  it('内置剧本：至少 2 个（磁盘清理+服务重启）', () => {
    expect(BUILTIN_PLAYBOOKS.length).toBeGreaterThanOrEqual(2);
    expect(BUILTIN_PLAYBOOKS.map((p) => p.name)).toContain('disk-cleanup');
    expect(BUILTIN_PLAYBOOKS.map((p) => p.name)).toContain('service-restart');
  });

  it('detect 模式：低危命令自动执行成功', async () => {
    const result = await executePlaybook(simplePlaybook, HUMAN);
    expect(result.status).toBe('completed');
    expect(result.steps.length).toBe(2);
    expect(result.steps[0]!.status).toBe('success');
    expect(result.steps[1]!.status).toBe('info');
  });

  it('training 模式：只记录不执行', async () => {
    const pb = { ...simplePlaybook, mode: 'training' as const };
    const result = await executePlaybook(pb, HUMAN);
    expect(result.status).toBe('completed');
    expect(result.steps[0]!.status).toBe('shadow');
    expect(result.steps[0]!.detail).toContain('[training]');
  });

  it('shadow 模式：记录"本应执行"但不真执行', async () => {
    const pb = { ...simplePlaybook, mode: 'shadow' as const };
    const result = await executePlaybook(pb, HUMAN);
    expect(result.status).toBe('shadow-completed');
    expect(result.steps[0]!.status).toBe('shadow');
    expect(result.steps[0]!.detail).toContain('[shadow]');
    expect(result.steps[0]!.actionId).toBeUndefined();
  });

  it('审批门：detect 模式下返回 awaiting-approval', async () => {
    const pb: PlaybookDefinition = {
      ...simplePlaybook,
      steps: [
        { id: 'gate', type: 'approval-gate', description: '人工确认', onFailure: 'abort' },
        ...simplePlaybook.steps,
      ],
    };
    const result = await executePlaybook(pb, HUMAN);
    expect(result.status).toBe('awaiting-approval');
    expect(result.steps[0]!.status).toBe('awaiting');
    expect(result.steps[0]!.detail).toContain('审批门');
  });

  it('失败中止：onFailure=abort 时停止后续步骤', async () => {
    const pb: PlaybookDefinition = {
      ...simplePlaybook,
      steps: [
        { id: 'fail', type: 'check', command: 'ls /nonexistent-dir-for-test', description: '故意失败', onFailure: 'abort' },
        { id: 's2', type: 'notify', notifyMessage: '不应到达', description: '通知', onFailure: 'continue' },
      ],
    };
    const result = await executePlaybook(pb, HUMAN);
    expect(result.status).toBe('aborted');
    expect(result.steps.length).toBe(1);
    expect(result.steps[0]!.status).toBe('failed');
  });

  it('失败继续：onFailure=continue 时继续执行', async () => {
    const pb: PlaybookDefinition = {
      ...simplePlaybook,
      steps: [
        { id: 'fail', type: 'check', command: 'ls /nonexistent-dir-for-test', description: '故意失败', onFailure: 'continue' },
        { id: 's2', type: 'notify', notifyMessage: '继续执行', description: '通知', onFailure: 'continue' },
      ],
    };
    const result = await executePlaybook(pb, HUMAN);
    expect(result.status).toBe('completed');
    expect(result.steps.length).toBe(2);
    expect(result.steps[1]!.status).toBe('info');
  });
});

describe('三相毕业机制', () => {
  it('训练不足 3 次 → 不满足毕业', () => {
    const records: GraduationRecord[] = [
      { playbookName: 'test', mode: 'training', runCount: 1, lastRunAt: new Date().toISOString(), graduated: false },
    ];
    const result = canGraduate(records);
    expect(result.eligible).toBe(false);
    expect(result.next).toBe('training');
    expect(result.reason).toContain('不足');
  });

  it('影子不足 3 次 → 不满足毕业', () => {
    const records: GraduationRecord[] = Array.from({ length: 3 }, (_, i) => ({
      playbookName: 'test', mode: 'training' as const, runCount: i + 1,
      lastRunAt: new Date().toISOString(), graduated: false,
    }));
    records.push({ playbookName: 'test', mode: 'shadow', runCount: 1, lastRunAt: new Date().toISOString(), graduated: false });
    const result = canGraduate(records);
    expect(result.eligible).toBe(false);
    expect(result.next).toBe('shadow');
  });

  it('训练≥3 + 影子≥3 → 满足毕业', () => {
    const records: GraduationRecord[] = [
      ...Array.from({ length: 3 }, (_, i) => ({
        playbookName: 'test', mode: 'training' as const, runCount: i + 1,
        lastRunAt: new Date().toISOString(), graduated: false,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        playbookName: 'test', mode: 'shadow' as const, runCount: i + 1,
        lastRunAt: new Date().toISOString(), graduated: false,
      })),
    ];
    const result = canGraduate(records);
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain('满足');
  });
});
