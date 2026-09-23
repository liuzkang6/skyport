/**
 * 行动服务（M2，spec/governance-loop/spec.md）：登记 / 审批 / 拒绝 / 取消 / 直通 / agent 一站式。
 * 治理红线：approve / reject / cancel / run 只允许 human actor；agent 走 create 与 agent run。
 * 查询与事件流在 action-queries.ts；跳板范围校验在 pivot.ts（单文件 ≤400 行规矩）。
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';
import { assertAgentMayCreateAction, getAgent, type ActorRef } from './agents';
import { executeAction, claimTransition, insertEvent, getLastExecution, type Execution } from './action-exec';
import { getAction } from './action-queries';
import { notifyPendingAction } from './notify';
import { getAsset } from './assets';
import { assertPivotScope } from './pivot';
import {
  applyHint,
  assessRisk,
  COMMAND_MAX_LENGTH,
  loadPolicy,
  normalizeCommand,
  REASON_MAX_LENGTH,
  tokenizeCommand,
  type RiskLevel,
} from './risk';

export const ACTION_STATUSES = [
  'pending',
  'approved',
  'executing',
  'success',
  'failed',
  'rejected',
  'cancelled',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

const TERMINAL_STATUSES: ReadonlySet<ActionStatus> = new Set(['success', 'failed', 'rejected', 'cancelled']);

export interface Action {
  readonly id: string;
  readonly command: string;
  readonly targetAssetId: string | undefined;
  readonly targetName: string;
  readonly targetKind: 'local' | 'ssh';
  readonly reason: string | undefined;
  readonly rollback: string | undefined;
  readonly riskLevel: RiskLevel;
  readonly riskSource: string;
  readonly status: ActionStatus;
  readonly actorType: 'human' | 'agent';
  readonly actorId: string;
  /** 发起者显示名（agent 的名字；human 为空——用 actorId 即用户名） */
  readonly actorName: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActionResult {
  readonly action: Action;
  readonly execution: Execution | undefined;
}

export interface CreateActionInput {
  readonly command: string;
  readonly actor: ActorRef;
  readonly target?: string | undefined;
  readonly reason?: string | undefined;
  readonly riskHint?: RiskLevel | undefined;
  readonly rollback?: string | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface ListActionsFilter {
  readonly status?: ActionStatus | undefined;
  /** agent 名字或 ID；也可以是 human 用户名（红队 U5） */
  readonly actor?: string | undefined;
  readonly target?: string | undefined;
  /** ISO 时间：只看此之后的行动 */
  readonly since?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** 读侧资产范围（红队 V5）：agent 令牌的 REST/MCP 查询按 glob 模式过滤目标；缺省不过滤 */
  readonly scopePatterns?: readonly string[] | undefined;
}

export interface ActionPage {
  readonly actions: readonly Action[];
  /** 还有更早的记录未展示（达到页大小） */
  readonly hasMore: boolean;
  /** 命中过滤条件的总数（QA #3：审计页"共 N 条"与分页依据） */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** 登记行动：校验 → 风险评估 → agent 三件套 → 入库 pending →（低危+策略允许）自动批准执行 */
export async function createAction(input: CreateActionInput): Promise<ActionResult> {
  // 红队 S15：入库前归一化（多行压单行），展示与执行同源
  const command = normalizeCommand(input.command.trim());
  if (command.length === 0 || command.length > COMMAND_MAX_LENGTH) {
    throw createError(ERROR_CODES.ACTION_INVALID, `命令长度需在 1-${COMMAND_MAX_LENGTH} 之间`, {
      context: { length: command.length },
    });
  }
  const tokens = tokenizeCommand(command); // 引号未闭合在此抛 ACTION_INVALID
  if (reasonInvalid(input.reason)) {
    throw createError(ERROR_CODES.ACTION_INVALID, `理由长度需在 0-${REASON_MAX_LENGTH} 之间`, { context: {} });
  }
  const policy = loadPolicy();
  const assessment = applyHint(assessRisk(command, policy), input.riskHint);

  // 红队护栏：high 风险行动必须提供回滚声明（spec/guardrails）
  if (assessment.level === 'high' && input.rollback === undefined && input.dryRun !== true) {
    throw createError(ERROR_CODES.ACTION_INVALID, 'high 风险行动必须提供 --rollback 回滚声明', {
      context: { command, risk: assessment.level },
    });
  }

  // dry-run：只评级展示，不落库不执行（spec/guardrails）
  if (input.dryRun === true) {
    return {
      action: {
        id: 'dry-run',
        command,
        targetAssetId: undefined,
        targetName: input.target ?? 'local',
        targetKind: 'local',
        reason: input.reason,
        rollback: input.rollback,
        riskLevel: assessment.level,
        riskSource: assessment.source,
        status: 'pending',
        actorType: input.actor.type,
        actorId: input.actor.id,
        actorName: input.actor.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      execution: undefined,
    };
  }

  // 目标解析：缺省本机；云账户不可作为执行目标；目标连接模式跟随资产登记
  let targetAssetId: string | undefined;
  let targetName = 'local';
  let targetKind: 'local' | 'ssh' = 'local';
  if (input.target !== undefined) {
    const asset = getAsset(input.target);
    if (asset.type === 'cloud-account') {
      throw createError(ERROR_CODES.ACTION_INVALID, `云账户不能作为执行目标: ${asset.name}`, {
        context: { asset: asset.name },
      });
    }
    targetAssetId = asset.id;
    targetName = asset.name;
    targetKind = asset.connectMode === 'local' ? 'local' : 'ssh';
  }

  if (input.actor.type === 'agent') {
    const agent = getAgent(input.actor.id);
    // 自动执行资格 = low + 策略开关 + scope + 单段无命令替换（红队 S14：组合命令必须过人）
    const autoEligible =
      assessment.level === 'low' &&
      assessment.autoExecEligible &&
      policy.autoExecLowRisk &&
      agent.scopes.includes('auto-exec-low') &&
      agent.scopes.includes('action:create');
    assertAgentMayCreateAction(agent, targetName, assessment.level, autoEligible);
  }
  // 跳板治理（红队 S4）：ssh/scp 段的二级目标是已登记资产且不在 agent 范围 → 门口拒绝
  assertPivotScope(input.actor, assessment.pivots);

  const now = new Date().toISOString();
  const action: Action = {
    id: `act_${randomBytes(4).toString('hex')}`,
    command,
    targetAssetId,
    targetName,
    targetKind,
    reason: input.reason,
    rollback: input.rollback,
    riskLevel: assessment.level,
    riskSource: assessment.source,
    status: 'pending',
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorName: input.actor.name,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO actions (id, command, target_asset_id, target_name, target_kind, reason, rollback, risk_level, risk_source, status, actor_type, actor_id, created_at, updated_at)
       VALUES (@id, @command, @targetAssetId, @targetName, @targetKind, @reason, @rollback, @riskLevel, @riskSource, 'pending', @actorType, @actorId, @createdAt, @updatedAt)`,
    )
    .run({
      id: action.id,
      command: action.command,
      targetAssetId: action.targetAssetId ?? null,
      targetName: action.targetName,
      targetKind: action.targetKind,
      reason: action.reason ?? null,
      rollback: action.rollback ?? null,
      riskLevel: action.riskLevel,
      riskSource: action.riskSource,
      actorType: action.actorType,
      actorId: action.actorId,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
    });
  insertEvent(action.id, 'created', input.actor, { risk: assessment.level, source: assessment.source, tokens: tokens.length });

  // 低危 + 单段 + 策略允许自动执行（human 直登也适用；组合命令/命令替换一律无资格，红队 S14）
  const humanAuto =
    input.actor.type === 'human' && assessment.level === 'low' && assessment.autoExecEligible && policy.autoExecLowRisk;
  const agentAuto =
    input.actor.type === 'agent' &&
    assessment.level === 'low' &&
    assessment.autoExecEligible &&
    policy.autoExecLowRisk &&
    getAgent(input.actor.id).scopes.includes('auto-exec-low');
  if (humanAuto || agentAuto) {
    if (!claimTransition(action.id, 'pending', 'approved')) {
      throw invalidStateError(action.id, 'auto-approved');
    }
    insertEvent(action.id, 'auto-approved', input.actor);
    const execution = await executeAction(action, input.actor);
    return { action: getAction(action.id), execution };
  }
  // 停在 pending 等人：发一条出站通知（未配置不发、失败不阻断——尽力而为）
  await notifyPendingAction(action);
  return { action, execution: undefined };
}

/** 人工审批：只允许 human（服务层再校验一次，不信任 CLI），放行后立即同步执行。
 * 状态迁移原子（红队 S10）：并发下只有一个 approve 成功。 */
export async function approveAction(actionId: string, actor: ActorRef): Promise<ActionResult> {
  requireHuman(actor, 'approve');
  const action = getAction(actionId);
  // 红队护栏：pending 超 24h 自动作废（spec/guardrails）
  expireStalePending(action);
  if (!claimTransition(actionId, 'pending', 'approved')) {
    throw invalidStateError(actionId, 'approve');
  }
  insertEvent(actionId, 'approved', actor);
  const execution = await executeAction(action, actor);
  return { action: getAction(actionId), execution };
}

export function rejectAction(actionId: string, actor: ActorRef, note?: string | undefined): Action {
  requireHuman(actor, 'reject');
  const action = getAction(actionId);
  if (!claimTransition(actionId, 'pending', 'rejected')) {
    throw invalidStateError(actionId, 'reject');
  }
  insertEvent(actionId, 'rejected', actor, note === undefined ? undefined : { note });
  return { ...action, status: 'rejected', updatedAt: new Date().toISOString() };
}

export function cancelAction(actionId: string, actor: ActorRef): Action {
  requireHuman(actor, 'cancel');
  const action = getAction(actionId);
  if (!claimTransition(actionId, 'pending', 'cancelled')) {
    throw invalidStateError(actionId, 'cancel');
  }
  insertEvent(actionId, 'cancelled', actor);
  return { ...action, status: 'cancelled', updatedAt: new Date().toISOString() };
}

/** 人自用直通：免审批（人是 root），风险照算照记，执行与审计全留痕 */
export async function runDirect(input: CreateActionInput): Promise<ActionResult> {
  if (input.actor.type !== 'human') {
    throw createError(ERROR_CODES.PERMISSION_DENIED, 'run 直通只允许人执行（AI 请用 agent run）', { context: {} });
  }
  const created = await createAction({ ...input, reason: input.reason });
  const actionId = created.action.id;
  // 直通：pending → 直接放行执行（低危自动路径已在 createAction 内消化）
  if (created.action.status === 'pending') {
    if (!claimTransition(actionId, 'pending', 'approved')) {
      throw invalidStateError(actionId, 'direct-run');
    }
    insertEvent(actionId, 'direct-run', input.actor);
    const execution = await executeAction(created.action, input.actor);
    return { action: getAction(actionId), execution };
  }
  return created;
}

/** AI 一站式：创建 → 等待（审批或自动执行）→ 返回最终状态；超时如实返回 pending。
 * onPending 回调在进入等待前触发（红队 U6：CLI 立即打印登记信息而非静默挂住）。 */
export async function agentRun(
  input: CreateActionInput,
  waitMs: number,
  onPending?: (action: Action) => void,
): Promise<ActionResult> {
  if (input.actor.type !== 'agent') {
    throw createError(ERROR_CODES.PERMISSION_DENIED, 'agent run 必须以 agent 身份调用（--api-key）', { context: {} });
  }
  const created = await createAction(input);
  if (isTerminal(created.action.status)) return created;
  onPending?.(created.action);
  return await waitForTerminal(created.action.id, waitMs);
}

/** 轮询一条行动直到终态或超时（超时如实返回当前状态） */
export async function waitForTerminal(actionId: string, waitMs: number): Promise<ActionResult> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const action = getAction(actionId);
    if (isTerminal(action.status)) return { action, execution: getLastExecution(actionId) };
  }
  return { action: getAction(actionId), execution: getLastExecution(actionId) };
}

const PENDING_EXPIRY_HOURS = 24;

/** pending 超 24h 自动作废（防止积压旧待办在环境变化后被误批） */
function expireStalePending(action: Action): void {
  if (action.status !== 'pending') return;
  const ageMs = Date.now() - Date.parse(action.createdAt);
  if (ageMs > PENDING_EXPIRY_HOURS * 3_600_000) {
    claimTransition(action.id, 'pending', 'cancelled');
    insertEvent(action.id, 'expired', { type: 'system', id: 'system' }, { reason: `pending 超 ${PENDING_EXPIRY_HOURS}h 自动作废` });
    throw createError(ERROR_CODES.ACTION_INVALID_STATE, `行动 ${action.id} 已过期（pending 超 ${PENDING_EXPIRY_HOURS}h），自动作废`, { context: { actionId: action.id, ageHours: Math.round(ageMs / 3_600_000) } });
  }
}

function invalidStateError(actionId: string, operation: string): Error {
  const current = getAction(actionId);
  return createError(
    ERROR_CODES.ACTION_INVALID_STATE,
    `行动 ${actionId} 当前状态为 ${current.status}，不能 ${operation}（仅 pending 可审批/取消）`,
    { context: { actionId, status: current.status, operation } },
  );
}

function requireHuman(actor: ActorRef, operation: string): void {
  if (actor.type !== 'human') {
    throw createError(ERROR_CODES.PERMISSION_DENIED, `${operation} 只允许人执行`, { context: { operation } });
  }
}

function isTerminal(status: ActionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function reasonInvalid(reason: string | undefined): boolean {
  return reason !== undefined && reason.length > REASON_MAX_LENGTH;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
