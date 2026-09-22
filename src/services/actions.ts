/**
 * 行动服务（M2，spec/governance-loop/spec.md）：登记 / 审批 / 拒绝 / 取消 / 直通 / agent 一站式。
 * 治理红线：approve / reject / cancel / run 只允许 human actor；agent 走 create 与 agent run。
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';
import {
  assertAgentMayCreateAction,
  getAgent,
  type ActorRef,
} from './agents';
import { executeAction, insertEvent, getLastExecution, type Execution } from './action-exec';
import { notifyPendingAction } from './notify';
import { getAsset } from './assets';
import {
  applyHint,
  assessRisk,
  COMMAND_MAX_LENGTH,
  loadPolicy,
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
  readonly riskLevel: RiskLevel;
  readonly riskSource: string;
  readonly status: ActionStatus;
  readonly actorType: 'human' | 'agent';
  readonly actorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActionEvent {
  readonly id: number;
  readonly event: string;
  readonly actorType: 'human' | 'agent';
  readonly actorId: string;
  readonly detail: string | undefined;
  readonly createdAt: string;
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
}

interface ActionRow {
  id: string;
  command: string;
  target_asset_id: string | null;
  target_name: string;
  target_kind: string;
  reason: string | null;
  risk_level: string;
  risk_source: string;
  status: string;
  actor_type: string;
  actor_id: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  event: string;
  actor_type: string;
  actor_id: string;
  detail: string | null;
  created_at: string;
}

/** 登记行动：校验 → 风险评估 → agent 三件套 → 入库 pending →（低危+策略允许）自动批准执行 */
export async function createAction(input: CreateActionInput): Promise<ActionResult> {
  const command = input.command.trim();
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
    // 自动执行资格也在这里一并校验（low + 策略开关 + scope）
    const autoEligible =
      assessment.level === 'low' &&
      policy.autoExecLowRisk &&
      agent.scopes.includes('auto-exec-low') &&
      agent.scopes.includes('action:create');
    assertAgentMayCreateAction(agent, targetName, assessment.level, autoEligible);
  }

  const now = new Date().toISOString();
  const action: Action = {
    id: `act_${randomBytes(4).toString('hex')}`,
    command,
    targetAssetId,
    targetName,
    targetKind,
    reason: input.reason,
    riskLevel: assessment.level,
    riskSource: assessment.source,
    status: 'pending',
    actorType: input.actor.type,
    actorId: input.actor.id,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO actions (id, command, target_asset_id, target_name, target_kind, reason, risk_level, risk_source, status, actor_type, actor_id, created_at, updated_at)
       VALUES (@id, @command, @targetAssetId, @targetName, @targetKind, @reason, @riskLevel, @riskSource, 'pending', @actorType, @actorId, @createdAt, @updatedAt)`,
    )
    .run({
      id: action.id,
      command: action.command,
      targetAssetId: action.targetAssetId ?? null,
      targetName: action.targetName,
      targetKind: action.targetKind,
      reason: action.reason ?? null,
      riskLevel: action.riskLevel,
      riskSource: action.riskSource,
      actorType: action.actorType,
      actorId: action.actorId,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
    });
  insertEvent(action.id, 'created', input.actor, { risk: assessment.level, source: assessment.source, tokens: tokens.length });

  // 低危 + 策略允许自动执行（human 直登也适用；人要审批可改策略 autoExecLowRisk=false）
  const humanAuto = input.actor.type === 'human' && assessment.level === 'low' && policy.autoExecLowRisk;
  const agentAuto =
    input.actor.type === 'agent' &&
    assessment.level === 'low' &&
    policy.autoExecLowRisk &&
    getAgent(input.actor.id).scopes.includes('auto-exec-low');
  if (humanAuto || agentAuto) {
    return await approveAndExecute(action.id, input.actor, 'auto-approved');
  }
  // 停在 pending 等人：发一条出站通知（未配置不发、失败不阻断——尽力而为）
  await notifyPendingAction(action);
  return { action, execution: undefined };
}

/** 人工审批：只允许 human（服务层再校验一次，不信任 CLI），放行后立即同步执行 */
export async function approveAction(actionId: string, actor: ActorRef): Promise<ActionResult> {
  requireHuman(actor, 'approve');
  return await approveAndExecute(actionId, actor, 'approved');
}

export function rejectAction(actionId: string, actor: ActorRef, note?: string | undefined): Action {
  requireHuman(actor, 'reject');
  const action = expectPending(actionId, 'reject');
  getDb()
    .prepare('UPDATE actions SET status = ?, updated_at = ? WHERE id = ?')
    .run('rejected', new Date().toISOString(), action.id);
  insertEvent(action.id, 'rejected', actor, note === undefined ? undefined : { note });
  return { ...action, status: 'rejected', updatedAt: new Date().toISOString() };
}

export function cancelAction(actionId: string, actor: ActorRef): Action {
  requireHuman(actor, 'cancel');
  const action = expectPending(actionId, 'cancel');
  getDb()
    .prepare('UPDATE actions SET status = ?, updated_at = ? WHERE id = ?')
    .run('cancelled', new Date().toISOString(), action.id);
  insertEvent(action.id, 'cancelled', actor);
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
    return await approveAndExecute(actionId, input.actor, 'direct-run');
  }
  return created;
}

/** AI 一站式：创建 → 等待（审批或自动执行）→ 返回最终状态；超时如实返回 pending */
export async function agentRun(input: CreateActionInput, waitMs: number): Promise<ActionResult> {
  if (input.actor.type !== 'agent') {
    throw createError(ERROR_CODES.PERMISSION_DENIED, 'agent run 必须以 agent 身份调用（--api-key）', { context: {} });
  }
  const created = await createAction(input);
  if (isTerminal(created.action.status)) return created;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const action = getAction(created.action.id);
    if (isTerminal(action.status)) return { action, execution: getLastExecution(action.id) };
  }
  return { action: getAction(created.action.id), execution: getLastExecution(created.action.id) };
}

export function listActions(status?: ActionStatus | undefined): Action[] {
  const rows =
    status === undefined
      ? (getDb().prepare('SELECT * FROM actions ORDER BY created_at DESC LIMIT 200').all() as ActionRow[])
      : (getDb().prepare('SELECT * FROM actions WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status) as ActionRow[]);
  return rows.map(rowToAction);
}

export function getAction(actionId: string): Action {
  const row = getDb().prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as ActionRow | undefined;
  if (row === undefined) {
    throw createError(ERROR_CODES.ACTION_NOT_FOUND, `行动不存在: ${actionId}`, { context: { actionId } });
  }
  return rowToAction(row);
}

export function getActionEvents(actionId: string): ActionEvent[] {
  getAction(actionId); // 不存在则 404 语义
  const rows = getDb()
    .prepare('SELECT * FROM action_events WHERE action_id = ? ORDER BY id ASC')
    .all(actionId) as EventRow[];
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    actorType: row.actor_type as 'human' | 'agent',
    actorId: row.actor_id,
    detail: row.detail ?? undefined,
    createdAt: row.created_at,
  }));
}

async function approveAndExecute(
  actionId: string,
  actor: ActorRef,
  event: 'approved' | 'auto-approved' | 'direct-run',
): Promise<ActionResult> {
  const action = expectPending(actionId, event);
  getDb()
    .prepare('UPDATE actions SET status = ?, updated_at = ? WHERE id = ?')
    .run('approved', new Date().toISOString(), action.id);
  insertEvent(action.id, event, actor);
  const execution = await executeAction(action, actor);
  return { action: getAction(action.id), execution };
}

function expectPending(actionId: string, operation: string): Action {
  const action = getAction(actionId);
  if (action.status !== 'pending') {
    throw createError(
      ERROR_CODES.ACTION_INVALID_STATE,
      `行动 ${action.id} 当前状态为 ${action.status}，不能 ${operation}（仅 pending 可审批/取消）`,
      { context: { actionId: action.id, status: action.status, operation } },
    );
  }
  return action;
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

function rowToAction(row: ActionRow): Action {
  return {
    id: row.id,
    command: row.command,
    targetAssetId: row.target_asset_id ?? undefined,
    targetName: row.target_name,
    targetKind: row.target_kind as 'local' | 'ssh',
    reason: row.reason ?? undefined,
    riskLevel: row.risk_level as RiskLevel,
    riskSource: row.risk_source,
    status: row.status as ActionStatus,
    actorType: row.actor_type as 'human' | 'agent',
    actorId: row.actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
