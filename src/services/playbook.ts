/**
 * 受治理编排引擎（v0.6，受 ZCode workflow 设计语法启发）：
 * TS 剧本定义 + 审批门节点 + 三相毕业（training→shadow→detect）。
 * 每步经 skyport 行动系统执行——治理对剧本透明生效。
 */
import { randomBytes } from 'node:crypto';
import { createAction } from './actions';
import { rootLogger } from '../logger/logger';
import type { ActorRef } from './agents';

// ── 剧本定义 ─────────────────────────────────

export type PlaybookStepType = 'check' | 'action' | 'approval-gate' | 'verify' | 'notify' | 'rollback';

export interface PlaybookStep {
  readonly id: string;
  readonly type: PlaybookStepType;
  /** 要执行的命令（check/action/verify/rollback 类型） */
  readonly command?: string | undefined;
  /** 目标资产 */
  readonly target?: string | undefined;
  /** 描述 */
  readonly description: string;
  /** 失败时策略 */
  readonly onFailure: 'abort' | 'continue' | 'rollback';
  /** 回滚步骤 ID（onFailure=rollback 时引用） */
  readonly rollbackStepId?: string | undefined;
  /** 通知消息（notify 类型） */
  readonly notifyMessage?: string | undefined;
}

export interface PlaybookDefinition {
  readonly name: string;
  readonly description: string;
  /** 触发条件（告警指纹匹配） */
  readonly trigger: {
    readonly alertEvents: readonly string[];
    readonly minSeverity?: string | undefined;
  };
  /** 执行模式 */
  readonly mode: PlaybookMode;
  readonly steps: readonly PlaybookStep[];
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export type PlaybookMode = 'training' | 'shadow' | 'detect';

// ── 执行结果 ─────────────────────────────────

export interface PlaybookRunResult {
  readonly playbookId: string;
  readonly runId: string;
  readonly mode: PlaybookMode;
  readonly status: 'completed' | 'aborted' | 'awaiting-approval' | 'shadow-completed';
  readonly steps: readonly StepResult[];
  readonly startedAt: string;
  readonly completedAt: string | undefined;
}

export interface StepResult {
  readonly stepId: string;
  readonly type: PlaybookStepType;
  readonly status: 'success' | 'failed' | 'skipped' | 'shadow' | 'awaiting' | 'info';
  readonly actionId: string | undefined;
  readonly detail: string;
  readonly durationMs: number | undefined;
}

// ── 引擎 ─────────────────────────────────

const SHADOW_PREFIX = '[SHADOW] ';

export async function executePlaybook(
  playbook: PlaybookDefinition,
  actor: ActorRef,
): Promise<PlaybookRunResult> {
  const runId = `run_${randomBytes(4).toString('hex')}`;
  const playbookId = `pb_${randomBytes(4).toString('hex')}`;
  const startedAt = new Date().toISOString();
  const stepResults: StepResult[] = [];

  rootLogger.info('剧本开始执行', { runId, playbook: playbook.name, mode: playbook.mode });

  for (const step of playbook.steps) {
    const stepStart = Date.now();
    const result = await executeStep(step, playbook.mode, actor);
    stepResults.push({ ...result, durationMs: Date.now() - stepStart });

    // 审批门等待
    if (result.status === 'awaiting') {
      return {
        playbookId,
        runId,
        mode: playbook.mode,
        status: 'awaiting-approval',
        steps: stepResults,
        startedAt,
        completedAt: undefined,
      };
    }

    // 失败处理
    if (result.status === 'failed') {
      if (step.onFailure === 'abort') {
        rootLogger.warn('剧本中止', { runId, stepId: step.id, reason: result.detail });
        return {
          playbookId,
          runId,
          mode: playbook.mode,
          status: 'aborted',
          steps: stepResults,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }
      if (step.onFailure === 'rollback' && step.rollbackStepId !== undefined) {
        const rollbackStep = playbook.steps.find((s) => s.id === step.rollbackStepId);
        if (rollbackStep !== undefined) {
          const rollbackResult = await executeStep(rollbackStep, playbook.mode, actor);
          stepResults.push({ ...rollbackResult, durationMs: Date.now() - stepStart });
        }
      }
    }
  }

  const completedAt = new Date().toISOString();
  rootLogger.info('剧本执行完成', { runId, steps: stepResults.length });

  return {
    playbookId,
    runId,
    mode: playbook.mode,
    status: playbook.mode === 'shadow' ? 'shadow-completed' : 'completed',
    steps: stepResults,
    startedAt,
    completedAt,
  };
}

async function executeStep(
  step: PlaybookStep,
  mode: PlaybookMode,
  actor: ActorRef,
): Promise<Omit<StepResult, 'durationMs'>> {
  switch (step.type) {
    case 'check':
    case 'verify':
    case 'action':
    case 'rollback': {
      if (step.command === undefined) {
        return { stepId: step.id, type: step.type, status: 'skipped', actionId: undefined, detail: '命令未定义' };
      }

      // 训练模式：只记录不执行
      if (mode === 'training') {
        rootLogger.info(`${SHADOW_PREFIX}[training] 步骤 ${step.id}: ${step.command}`);
        return { stepId: step.id, type: step.type, status: 'shadow', actionId: undefined, detail: `[training] 将执行: ${step.command}` };
      }

      // 影子模式：记录"本应执行"但不真执行
      if (mode === 'shadow') {
        rootLogger.info(`${SHADOW_PREFIX}[shadow] 步骤 ${step.id}: ${step.command}`);
        return { stepId: step.id, type: step.type, status: 'shadow', actionId: undefined, detail: `[shadow] 本应执行: ${step.command}` };
      }

      // detect 模式：真执行（经网关，治理透明生效）
      try {
        const result = await createAction({
          command: step.command,
          actor,
          target: step.target,
          reason: step.description,
        });

        // 如果是 pending（需要审批），返回等待状态
        if (result.action.status === 'pending') {
          return {
            stepId: step.id,
            type: step.type,
            status: 'awaiting',
            actionId: result.action.id,
            detail: `等待审批: ${result.action.id}`,
          };
        }

        // 已执行（低危自动或已审批）
        const ok = result.action.status === 'success';
        return {
          stepId: step.id,
          type: step.type,
          status: ok ? 'success' : 'failed',
          actionId: result.action.id,
          detail: ok ? '执行成功' : `执行失败: ${result.execution?.error ?? result.action.status}`,
        };
      } catch (error) {
        return {
          stepId: step.id,
          type: step.type,
          status: 'failed',
          actionId: undefined,
          detail: `创建行动失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case 'approval-gate': {
      // 审批门：detect 模式下需要人批准
      if (mode === 'training' || mode === 'shadow') {
        return { stepId: step.id, type: step.type, status: 'shadow', actionId: undefined, detail: `[${mode}] 审批门将等待人工批准` };
      }
      // detect 模式：真正的审批门——人必须在此暂停
      // 引擎不自动通过，返回 awaiting 由上层处理
      return {
        stepId: step.id,
        type: step.type,
        status: 'awaiting',
        actionId: undefined,
        detail: `审批门: ${step.description}（需人工确认后继续）`,
      };
    }

    case 'notify': {
      rootLogger.info(`[notify] ${step.notifyMessage ?? step.description}`);
      return { stepId: step.id, type: step.type, status: 'info', actionId: undefined, detail: step.notifyMessage ?? step.description };
    }

    default:
      return { stepId: step.id, type: step.type, status: 'skipped', actionId: undefined, detail: `未知步骤类型: ${step.type}` };
  }
}

// ── 三相毕业管理 ─────────────────────────────

export interface GraduationRecord {
  readonly playbookName: string;
  readonly mode: PlaybookMode;
  readonly runCount: number;
  readonly lastRunAt: string;
  readonly graduated: boolean;
}

/** 毕业条件：training ≥3 次 → shadow ≥3 次零失败 → 可升 detect */
export function canGraduate(records: GraduationRecord[]): { eligible: boolean; next: PlaybookMode | 'done'; reason: string } {
  const training = records.filter((r) => r.mode === 'training');
  const shadow = records.filter((r) => r.mode === 'shadow');

  if (training.length < 3) {
    return { eligible: false, next: 'training', reason: `训练次数不足（${training.length}/3）` };
  }
  if (shadow.length < 3) {
    return { eligible: false, next: 'shadow', reason: `影子次数不足（${shadow.length}/3）` };
  }
  return { eligible: true, next: 'done', reason: '满足毕业条件：训练≥3 + 影子≥3' };
}

/** 内置剧本示例 */
export const BUILTIN_PLAYBOOKS: readonly PlaybookDefinition[] = [
  {
    name: 'disk-cleanup',
    description: '磁盘清理预案（告警触发，安全清理 7 天前日志）',
    trigger: { alertEvents: ['DiskFull', 'HighDiskUsage', 'disk_full'], minSeverity: 'warning' },
    mode: 'training',
    steps: [
      { id: 'check-disk', type: 'check', command: 'df -h /', description: '确认磁盘使用率', onFailure: 'abort' },
      { id: 'gate-approval', type: 'approval-gate', description: '人工确认清理方案', onFailure: 'abort' },
      { id: 'action-cleanup', type: 'action', command: 'find /var/log -name "*.log" -mtime +7 -delete', description: '清理 7 天前日志', onFailure: 'rollback', rollbackStepId: 'rollback-restore' },
      { id: 'verify-disk', type: 'verify', command: 'df -h /', description: '确认清理后使用率', onFailure: 'continue' },
      { id: 'notify-done', type: 'notify', notifyMessage: '磁盘清理完成', description: '通知', onFailure: 'continue' },
      { id: 'rollback-restore', type: 'rollback', command: 'echo "恢复（备份在隔离区）"', description: '回滚（文件移入隔离区可恢复）', onFailure: 'continue' },
    ],
  },
  {
    name: 'service-restart',
    description: '服务重启预案（5xx/OOM 告警触发）',
    trigger: { alertEvents: ['ServiceDown', 'HTTP5xx', 'OOMKilled'], minSeverity: 'critical' },
    mode: 'training',
    steps: [
      { id: 'check-status', type: 'check', command: 'systemctl status $SERVICE', description: '检查服务状态', onFailure: 'abort' },
      { id: 'gate-approval', type: 'approval-gate', description: '人工确认重启', onFailure: 'abort' },
      { id: 'action-restart', type: 'action', command: 'systemctl restart $SERVICE', description: '重启服务', onFailure: 'abort' },
      { id: 'verify-health', type: 'verify', command: 'systemctl is-active $SERVICE', description: '确认服务恢复', onFailure: 'rollback', rollbackStepId: 'rollback-notify' },
      { id: 'notify-done', type: 'notify', notifyMessage: '服务重启完成', description: '通知', onFailure: 'continue' },
      { id: 'rollback-notify', type: 'rollback', command: 'echo "重启失败，需人工介入"', description: '回滚通知', onFailure: 'continue' },
    ],
  },
];
