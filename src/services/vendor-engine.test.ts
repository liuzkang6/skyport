import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { compilePlaybookToSnapshot, executeViaVendorEngine } from './vendor-engine';
import { executeViaBridge } from './workflow-bridge';
import { approveAction } from './actions';
import { getAction } from './action-queries';
import { humanUserId, type ActorRef } from './agents';

let tempDir: string;
const HUMAN: ActorRef = { type: 'human', id: humanUserId(), name: humanUserId() };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-vendor-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  // detect 模式需要低危自动执行策略
  const policyFile = join(tempDir, 'skyport.policy.json');
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

function countActions(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number }).n;
}

describe('vendored ZCode 引擎真跑（v0.6 收尾）', () => {
  it('桥接真跑：executeViaBridge 走 vendored 引擎（不再委托原生 playbook）', async () => {
    const result = await executeViaBridge({
      name: 'bridge-run', description: '桥接真跑', trigger: { alertEvents: ['X'] }, mode: 'detect',
      steps: [
        { id: 'b1', type: 'check', command: 'echo bridge-vendor-ok', description: '检查', onFailure: 'abort' },
      ],
    }, HUMAN);
    expect(result.status).toBe('completed');
    expect(result.steps[0]!.status).toBe('success');
    expect(countActions()).toBe(1);
  });

  it('编译：剧本 → 引擎快照（节点=步骤、线性边、单相位）', () => {
    const snapshot = compilePlaybookToSnapshot({
      name: 'compile-test', description: '编译测试', trigger: { alertEvents: ['X'] }, mode: 'detect',
      steps: [
        { id: 'a', type: 'check', command: 'echo 1', description: 'A', onFailure: 'abort' },
        { id: 'b', type: 'action', command: 'echo 2', description: 'B', onFailure: 'abort' },
        { id: 'c', type: 'notify', notifyMessage: 'n', description: 'C', onFailure: 'continue' },
      ],
    });
    expect(snapshot.graph.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(snapshot.graph.edges).toEqual([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    expect(snapshot.phases).toEqual([{ phase: 'exec', status: 'active' }]);
    expect(snapshot.strategy.executor.maxConcurrentLoops).toBe(1);
  });

  it('detect 模式：低危自动执行，全步经引擎调度成功', async () => {
    const result = await executeViaVendorEngine({
      name: 'detect-run', description: 'detect 真跑', trigger: { alertEvents: ['X'] }, mode: 'detect',
      steps: [
        { id: 's1', type: 'check', command: 'echo vendor-engine-ok', description: '检查', onFailure: 'abort' },
        { id: 's2', type: 'verify', command: 'echo verify-ok', description: '验证', onFailure: 'abort' },
        { id: 's3', type: 'notify', notifyMessage: '完成', description: '通知', onFailure: 'continue' },
      ],
    }, HUMAN);
    expect(result.status).toBe('completed');
    expect(result.steps.map((s) => s.status)).toEqual(['success', 'success', 'info']);
    // 每个命令步骤都落了真实行动（治理透明生效）
    expect(countActions()).toBe(2);
    expect(result.steps[0]!.actionId).toMatch(/^act_/);
  });

  it('training 模式：记录不执行（零行动创建）', async () => {
    const result = await executeViaVendorEngine({
      name: 'training-run', description: '训练', trigger: { alertEvents: ['X'] }, mode: 'training',
      steps: [
        { id: 't1', type: 'check', command: 'echo nope', description: '检查', onFailure: 'abort' },
        { id: 't2', type: 'action', command: 'echo nope2', description: '动作', onFailure: 'abort' },
      ],
    }, HUMAN);
    expect(result.status).toBe('completed');
    expect(result.steps.map((s) => s.status)).toEqual(['shadow', 'shadow']);
    expect(countActions()).toBe(0);
  });

  it('失败中止：步骤失败后续不执行（引擎串行链）', async () => {
    const result = await executeViaVendorEngine({
      name: 'fail-run', description: '失败路径', trigger: { alertEvents: ['X'] }, mode: 'detect',
      steps: [
        { id: 'f1', type: 'check', command: 'ls /nonexistent-vendor-path', description: '必失败', onFailure: 'abort' },
        { id: 'f2', type: 'notify', notifyMessage: '不应到达', description: '后续', onFailure: 'continue' },
      ],
    }, HUMAN);
    expect(result.status).toBe('aborted');
    expect(result.steps[0]!.status).toBe('failed');
    // 后续步骤未执行（paused 留在 pending，映射 skipped）
    expect(['skipped', 'shadow']).toContain(result.steps[1]!.status);
  });

  it('审批门：detect 模式停在门口 → awaiting-approval', async () => {
    const result = await executeViaVendorEngine({
      name: 'gate-run', description: '审批门', trigger: { alertEvents: ['X'] }, mode: 'detect',
      steps: [
        { id: 'g1', type: 'check', command: 'echo pre-gate', description: '门前检查', onFailure: 'abort' },
        { id: 'g2', type: 'approval-gate', description: '人工确认', onFailure: 'abort' },
        { id: 'g3', type: 'action', command: 'echo after-gate', description: '门后动作', onFailure: 'abort' },
      ],
    }, HUMAN, { retryDelayMs: 30 });
    expect(result.status).toBe('awaiting-approval');
    expect(result.steps[1]!.status).toBe('awaiting');
    expect(result.steps[2]!.status).toBe('skipped'); // 门未开，后续未执行
    expect(countActions()).toBe(1); // 只有门前检查
  });

  it('审批等待：action pending → 窗口内人工批准 → 继续执行', async () => {
    // 高危命令必 pending；500ms 后由"人"批准
    setTimeout(() => {
      const row = getDb().prepare("SELECT id FROM actions WHERE status = 'pending' LIMIT 1").get() as { id: string } | undefined;
      if (row !== undefined) void approveAction(row.id, HUMAN);
    }, 500);

    const result = await executeViaVendorEngine({
      name: 'approve-wait', description: '审批等待', trigger: { alertEvents: ['X'] }, mode: 'detect',
      steps: [
        { id: 'w1', type: 'action', command: 'echo approved-and-ran', description: '高危动作（rm 前缀必 pending）', onFailure: 'abort' },
        { id: 'w2', type: 'notify', notifyMessage: '收尾', description: '通知', onFailure: 'continue' },
      ],
    }, HUMAN, { approvalTimeoutMs: 10_000, retryDelayMs: 50 });

    expect(result.status).toBe('completed');
    expect(result.steps[0]!.status).toBe('success');
    expect(result.steps[1]!.status).toBe('info');
    const action = getAction(result.steps[0]!.actionId!);
    expect(action.status).toBe('success');
  }, 20_000);

  it('审批超时：窗口内无人批准 → 引擎错误阈值暂停 → aborted 映射', async () => {
    const result = await executeViaVendorEngine({
      name: 'approve-timeout', description: '审批超时', trigger: { alertEvents: ['X'] }, mode: 'detect',
        steps: [
          { id: 'x1', type: 'action', command: 'node -e "console.log(1)"', description: '中危动作（必 pending）', onFailure: 'abort' },
        ],
    }, HUMAN, { approvalTimeoutMs: 300, retryDelayMs: 20 });

    expect(result.status).toBe('aborted');
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.detail).toContain('等待审批超时');
  });
});
