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
  globMatch,
  type ActorRef,
} from './agents';
import { executeAction, claimTransition, insertEvent, getLastExecution, type Execution } from './action-exec';
import { notifyPendingAction } from './notify';
import { getAsset, listAssets, parseAddr, type Asset } from './assets';
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
  actor_name: string | null;
  created_at: string;
  updated_at: string;
}

/** 行动查询统一带 agent 名字（红队 U2：发起者不显示内部 ID） */
const ACTION_SELECT =
  'SELECT a.*, g.name AS actor_name FROM actions a LEFT JOIN agents g ON a.actor_type = \'agent\' AND a.actor_id = g.id';

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

export interface ListActionsFilter {
  readonly status?: ActionStatus | undefined;
  /** agent 名字或 ID；也可以是 human 用户名（红队 U5） */
  readonly actor?: string | undefined;
  readonly target?: string | undefined;
  /** ISO 时间：只看此之后的行动 */
  readonly since?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ActionPage {
  readonly actions: readonly Action[];
  /** 还有更早的记录未展示（达到页大小） */
  readonly hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 200;

export function listActions(filter: ListActionsFilter = {}): ActionPage {
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};
  if (filter.status !== undefined) {
    conditions.push('a.status = @status');
    params.status = filter.status;
  }
  if (filter.target !== undefined) {
    conditions.push('a.target_name = @target');
    params.target = filter.target;
  }
  if (filter.since !== undefined) {
    conditions.push('a.created_at >= @since');
    params.since = filter.since;
  }
  if (filter.actor !== undefined) {
    // 名字优先解析成 agent id；解析不了按原值匹配（human 用户名或直接传 agent id）
    let actorKey = filter.actor;
    try {
      actorKey = getAgent(filter.actor).id;
    } catch {
      // 保持原值
    }
    conditions.push(
      "((a.actor_type = 'agent' AND a.actor_id = @actor) OR (a.actor_type = 'human' AND a.actor_id = @actorHuman))",
    );
    params.actor = actorKey;
    params.actorHuman = filter.actor;
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
  const offset = filter.offset ?? 0;
  const rows = getDb()
    .prepare(`${ACTION_SELECT}${where} ORDER BY a.created_at DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: limit + 1, offset }) as ActionRow[];
  const hasMore = rows.length > limit;
  return { actions: rows.slice(0, limit).map(rowToAction), hasMore };
}

export function getAction(actionId: string): Action {
  const row = getDb().prepare(`${ACTION_SELECT} WHERE a.id = ?`).get(actionId) as ActionRow | undefined;
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

/** 二级目标解析：跳板主机名对应哪台已登记资产（按名字或地址主机部分） */
function findAssetByTarget(target: string): Asset | undefined {
  const all = listAssets();
  const byName = all.find((asset) => asset.name === target);
  if (byName !== undefined) return byName;
  return all.find((asset) => {
    if (asset.addr === undefined) return false;
    try {
      return parseAddr(asset.addr, asset.connectMode).host === target;
    } catch {
      return false;
    }
  });
}

/** 人是 root 不做范围校验（风险地板仍由引擎给出）；agent 的跳板必须在授权资产范围内 */
function assertPivotScope(actor: ActorRef, pivots: readonly string[]): void {
  if (actor.type !== 'agent') return;
  const agent = getAgent(actor.id);
  for (const pivot of pivots) {
    const asset = findAssetByTarget(pivot);
    if (asset === undefined) continue; // 未登记主机：引擎已给 ≥medium，高危靠风险上限兜底
    if (!agent.assetPatterns.some((pattern) => globMatch(pattern, asset.name))) {
      throw createError(ERROR_CODES.PERMISSION_DENIED, `命令内嵌跳板目标不在 agent 资产授权范围: ${pivot}`, {
        context: { agent: agent.name, pivot, patterns: agent.assetPatterns },
      });
    }
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
    actorName: row.actor_name ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
