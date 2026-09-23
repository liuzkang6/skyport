/**
 * vendored ZCode 工作流引擎真跑驱动（PRD v0.6 收尾）：
 * 此前 workflow-bridge 仅做类型映射、执行委托给原生 playbook.ts；
 * 本模块把 skyport 剧本编译成引擎的 WorkflowRunSnapshot，交给
 * vendor/zcode-runtime 的 WorkflowGraphScheduler 真正调度执行——
 * 并发控制/错误阈值/前沿事件/死锁检测全部来自引擎本体。
 *
 * 治理语义与原生 playbook.ts 对齐（每步仍经 skyport 行动系统）：
 * - training/shadow：记录不执行（runner 返回 shadow 摘要）
 * - detect：check/verify/action/rollback → createAction 真执行；
 *   pending（需审批）时轮询至终态，超时抛错由引擎按错误阈值暂停
 * - approval-gate：detect 模式下抛 AwaitApprovalError，引擎重试耗尽后
 *   paused，桥接层映射为 awaiting-approval（与原生"停在门口等人"等价）
 */
import { randomBytes } from 'node:crypto';
import type { ActorRef } from './agents';
import { createAction } from './actions';
import { getAction } from './action-queries';
import { rootLogger } from '../logger/logger';
import type { PlaybookDefinition, PlaybookRunResult, PlaybookStep, StepResult, PlaybookMode } from './playbook';
import { WorkflowGraphScheduler } from '../../vendor/zcode-runtime/workflow/scheduler.js';
import type {
  WorkflowEvent,
  WorkflowGraphNode,
  WorkflowGraphRecord,
  WorkflowRunSnapshot,
} from '../../vendor/zcode-runtime/contracts';

export interface VendorEngineOptions {
  /** detect 模式下行动 pending 的审批等待上限（毫秒） */
  readonly approvalTimeoutMs?: number | undefined;
  /** 引擎节点重试之间的间隔（毫秒，防热循环） */
  readonly retryDelayMs?: number | undefined;
}

interface StepMeta {
  readonly command: string | undefined;
  readonly target: string | undefined;
  readonly onFailure: 'abort' | 'continue' | 'rollback';
  readonly rollbackStepId: string | undefined;
  readonly notifyMessage: string | undefined;
}

const AWAIT_APPROVAL = '审批门等待人工确认（awaiting-approval）';

/** 剧本 → 引擎运行快照：每步一节点、线性依赖边、单执行相位 */
export function compilePlaybookToSnapshot(playbook: PlaybookDefinition): WorkflowRunSnapshot {
  const now = new Date().toISOString();
  const nodes: WorkflowGraphNode[] = playbook.steps.map((step) => ({
    id: step.id,
    title: step.description,
    description: step.description,
    prompt: step.command,
    phase: 'exec',
    status: 'pending',
    kind: step.type,
    dependsOn: [],
    metadata: {
      command: step.command,
      target: step.target,
      onFailure: step.onFailure,
      rollbackStepId: step.rollbackStepId,
      notifyMessage: step.notifyMessage,
    },
  }));
  // 线性链：steps[i] → steps[i+1]（rollback 引用按原生语义由失败路径即时执行，不建边）
  const edges = playbook.steps.slice(1).map((step, i) => ({
    from: playbook.steps[i]?.id as string,
    to: step.id,
  }));
  const runId = `run_${randomBytes(4).toString('hex')}`;
  return {
    runId,
    kind: 'skyport-playbook',
    task: `${playbook.name}: ${playbook.description}`,
    cwd: process.cwd(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    strategy: {
      executor: {
        maxConcurrentLoops: 1, // 顺序治理：剧本步骤串行（与原生语义一致）
        maxConsecutiveErrors: 3,
        maxPlannerRuns: 0,
        frontierTarget: 3,
        drainingChangeHours: 1,
      },
    },
    graph: { nodes, edges, collections: [] },
    phases: [{ phase: 'exec', status: 'active' }],
    activities: [],
    artifacts: [],
    sessionLinks: { runId, sessionIds: [], links: [] },
  };
}

/** 经 vendored 引擎执行剧本（受治理：每步走 skyport 行动系统） */
export async function executeViaVendorEngine(
  playbook: PlaybookDefinition,
  actor: ActorRef,
  options: VendorEngineOptions = {},
): Promise<PlaybookRunResult> {
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const snapshot = compilePlaybookToSnapshot(playbook);
  const startedAt = new Date().toISOString();
  const playbookId = `pb_${randomBytes(4).toString('hex')}`;
  const events: WorkflowEvent[] = [];
  const records: WorkflowGraphRecord[] = [];
  const artifactContents = new Map<string, string>();
  let activitySeq = 0;

  rootLogger.info('vendored 引擎执行剧本', { runId: snapshot.runId, playbook: playbook.name, mode: playbook.mode });

  const runner = {
    async run(input: { node: WorkflowGraphNode; activityId: string }): Promise<{ response: string; sessionId: string }> {
      const meta = (input.node.metadata ?? {}) as Partial<StepMeta>;
      const step: PlaybookStep = {
        id: input.node.id,
        type: (input.node.kind ?? 'check') as PlaybookStep['type'],
        command: meta.command,
        target: meta.target,
        description: input.node.title,
        onFailure: meta.onFailure ?? 'abort',
        rollbackStepId: meta.rollbackStepId,
        notifyMessage: meta.notifyMessage,
      };
      return runGovernedStep(step, playbook.mode, actor, { approvalTimeoutMs, retryDelayMs });
    },
  };

  const scheduler = new WorkflowGraphScheduler({
    appendEvent: async (event) => { events.push(event); },
    appendGraphRecord: async (_runId, record) => { records.push(record); },
    createActivityId: () => `act_${(activitySeq += 1)}`,
    now: () => new Date(),
    onWorkflowEvent: (event) => {
      if (event.type === 'node_failed' || event.type === 'executor_paused') {
        rootLogger.warn('工作流事件', { runId: event.runId, type: event.type, message: event.message });
      }
    },
    runner,
    writeArtifact: async (_runId, relativePath, content) => {
      artifactContents.set(relativePath, content);
      return { path: relativePath, relativePath };
    },
    writeSnapshot: async () => { /* 快照仅驻内存（journal 由 events/records 承担） */ },
  });

  const outcome = await scheduler.run({ cwd: process.cwd(), phase: 'exec', snapshot });

  return mapEngineResult(outcome, playbook, playbookId, snapshot.runId, startedAt, artifactContents, events);
}

/** 单步受治理执行（语义对齐 playbook.ts executeStep） */
async function runGovernedStep(
  step: PlaybookStep,
  mode: PlaybookMode,
  actor: ActorRef,
  opts: { approvalTimeoutMs: number; retryDelayMs: number },
): Promise<{ response: string; sessionId: string }> {
  switch (step.type) {
    case 'check':
    case 'verify':
    case 'action':
    case 'rollback': {
      if (step.command === undefined) {
        return { response: `步骤 ${step.id}: 命令未定义（跳过）`, sessionId: 'none' };
      }
      if (mode === 'training' || mode === 'shadow') {
        rootLogger.info(`[SHADOW][${mode}] 步骤 ${step.id}: ${step.command}`);
        return { response: `[${mode}] 本应执行: ${step.command}`, sessionId: 'shadow' };
      }
      // detect：真执行（经网关，治理透明生效）
      const result = await createAction({
        command: step.command,
        actor,
        target: step.target,
        reason: step.description,
      });
      if (result.action.status === 'pending') {
        // 需审批：轮询至终态（人在窗口内批准则继续，超时交引擎错误阈值处理）
        const finalAction = await waitForTerminalStatus(result.action.id, opts.approvalTimeoutMs, opts.retryDelayMs);
        if (finalAction === undefined) {
          throw new Error(`等待审批超时（${opts.approvalTimeoutMs}ms）: ${result.action.id}`);
        }
        if (finalAction !== 'success') throw new Error(`审批后执行未成功: ${finalAction}`);
        return summarize(true, result.action.id, finalAction, result.execution?.stdout);
      }
      const ok = result.action.status === 'success';
      if (!ok) throw new Error(`执行失败: ${result.execution?.error ?? result.action.status}`);
      return summarize(true, result.action.id, result.action.status, result.execution?.stdout);
    }
    case 'approval-gate': {
      if (mode === 'training' || mode === 'shadow') {
        return { response: `[${mode}] 审批门将等待人工批准`, sessionId: 'shadow' };
      }
      // detect：停在门口等人——引擎重试耗尽后 paused，桥接层映射 awaiting-approval
      await sleep(opts.retryDelayMs);
      throw new Error(AWAIT_APPROVAL);
    }
    case 'notify': {
      const message = step.notifyMessage ?? step.description;
      rootLogger.info(`[notify] ${message}`);
      return { response: `[notify] ${message}`, sessionId: 'notify' };
    }
    default:
      return { response: `未知步骤类型: ${step.type}`, sessionId: 'none' };
  }
}

function summarize(ok: boolean, actionId: string, status: string, stdout: string | undefined): { response: string; sessionId: string } {
  const clipped = stdout !== undefined && stdout.length > 2_000 ? `${stdout.slice(0, 2_000)}…` : (stdout ?? '');
  return {
    response: ok ? `行动 ${actionId} ${status}\n${clipped}` : `行动 ${actionId} ${status}`,
    sessionId: actionId,
  };
}

async function waitForTerminalStatus(actionId: string, timeoutMs: number, pollMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const action = getAction(actionId);
    if (action.status !== 'pending' && action.status !== 'approved' && action.status !== 'executing') {
      return action.status;
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.max(pollMs, 50));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 引擎结果 → PlaybookRunResult（对外契约不变，上层无感切换） */
function mapEngineResult(
  outcome: { reason: 'completed' | 'deadlock' | 'error_threshold'; snapshot: WorkflowRunSnapshot; status: 'completed' | 'paused' },
  playbook: PlaybookDefinition,
  playbookId: string,
  runId: string,
  startedAt: string,
  artifactContents: Map<string, string>,
  events: readonly WorkflowEvent[],
): PlaybookRunResult {
  void artifactContents; // 工件内容已随 events/records 留痕，结果摘要取节点状态
  void events;
  // 节点 → 行动 ID：从活动快照取 sessionId（runner 以 actionId 作为会话标识）
  const actionIdByNode = new Map(
    outcome.snapshot.activities
      .filter((activity) => activity.nodeId !== undefined && activity.sessionId !== undefined && activity.sessionId.startsWith('act_'))
      .map((activity) => [activity.nodeId as string, activity.sessionId as string]),
  );
  const steps: StepResult[] = outcome.snapshot.graph.nodes.map((node) => {
    const shadow = playbook.mode === 'training' || playbook.mode === 'shadow';
    const gateAwaiting = node.kind === 'approval-gate' && node.status === 'failed' && node.error === AWAIT_APPROVAL;
    let status: StepResult['status'];
    let detail = node.error ?? node.title;
    if (gateAwaiting) {
      status = 'awaiting';
      detail = `审批门: ${node.title}（需人工确认后继续）`;
    } else if (node.status === 'completed') {
      status = node.kind === 'notify' ? 'info' : (shadow ? 'shadow' : 'success');
    } else if (node.status === 'failed') {
      status = 'failed';
    } else if (node.status === 'skipped' || node.status === 'cancelled') {
      status = 'skipped';
    } else {
      status = shadow ? 'shadow' : 'skipped'; // pending/active（paused 时未及执行的步骤）
    }
    return {
      stepId: node.id,
      type: (node.kind ?? 'check') as StepResult['type'],
      status,
      actionId: actionIdByNode.get(node.id),
      detail,
      durationMs: undefined,
    };
  });

  let status: PlaybookRunResult['status'];
  const hasGateAwaiting = steps.some((s) => s.status === 'awaiting');
  if (outcome.status === 'completed') {
    status = playbook.mode === 'shadow' ? 'shadow-completed' : 'completed';
  } else if (hasGateAwaiting) {
    status = 'awaiting-approval';
  } else {
    status = 'aborted';
  }

  rootLogger.info('vendored 引擎剧本结束', { runId, reason: outcome.reason, status });
  return { playbookId, runId, mode: playbook.mode, status, steps, startedAt, completedAt: new Date().toISOString() };
}
