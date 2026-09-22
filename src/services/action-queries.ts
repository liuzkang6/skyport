/**
 * 行动台账查询（从 actions 拆出，单文件 ≤400 行规矩）：
 * 发起者带 agent 名字（红队 U2）、过滤分页（红队 U5）、事件流读取。
 */
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';
import { getAgent } from './agents';
import type { Action, ActionStatus, ActionPage, ListActionsFilter } from './actions';
import type { RiskLevel } from './risk';

export interface ActionEvent {
  readonly id: number;
  readonly event: string;
  readonly actorType: 'human' | 'agent';
  readonly actorId: string;
  readonly detail: string | undefined;
  readonly createdAt: string;
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

interface EventRow {
  id: number;
  event: string;
  actor_type: string;
  actor_id: string;
  detail: string | null;
  created_at: string;
}

/** 行动查询统一带 agent 名字（红队 U2：发起者不显示内部 ID） */
const ACTION_SELECT =
  'SELECT a.*, g.name AS actor_name FROM actions a LEFT JOIN agents g ON a.actor_type = \'agent\' AND a.actor_id = g.id';

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
