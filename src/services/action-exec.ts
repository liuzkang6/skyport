/**
 * 行动执行桥（M2）：把一条行动解析成本机/SSH 目标，经唯一执行器执行并落审计。
 * 执行不在 SQLite 事务里（executor 是异步的）——状态推进以事件流为准（spec 已注明）。
 */
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { execute } from '../executor/executor';
import { rootLogger } from '../logger/logger';
import { getAsset, parseAddr } from './assets';
import { tokenizeCommand } from './risk';

export interface ActionCore {
  readonly id: string;
  readonly command: string;
  readonly targetAssetId: string | undefined;
  readonly targetName: string;
  readonly targetKind: 'local' | 'ssh';
}

export interface Execution {
  readonly id: number;
  readonly actionId: string;
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly error: string | undefined;
  readonly createdAt: string;
}

interface ExecutionRow {
  id: number;
  action_id: string;
  ok: number;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: number;
  duration_ms: number;
  error: string | null;
  created_at: string;
}

interface ExecSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** 解析执行目标：本机直接用 token[0]；SSH 走资产的 addr（支持 host:port 与 ssh config 别名） */
function buildExecSpec(action: ActionCore): ExecSpec {
  const tokens = tokenizeCommand(action.command);
  const head = tokens[0];
  if (head === undefined) {
    throw createError(ERROR_CODES.ACTION_INVALID, '命令切分后为空', { context: { command: action.command } });
  }
  const rest = tokens.slice(1);
  if (action.targetKind === 'local') return { command: head, args: rest };
  if (action.targetAssetId === undefined) {
    throw createError(ERROR_CODES.ACTION_INVALID, `行动目标资产已失效: ${action.targetName}`, {
      context: { actionId: action.id },
    });
  }
  const asset = getAsset(action.targetAssetId);
  if (asset.addr === undefined) {
    throw createError(ERROR_CODES.ACTION_INVALID, `目标资产无地址，无法 SSH 执行: ${asset.name}`, {
      context: { actionId: action.id },
    });
  }
  const { user, host, port } = parseAddr(asset.addr, asset.connectMode ?? 'ssh');
  // 带 user@ 前缀以指定用户登录；省略 user 时 ssh 用本机当前用户（文档已注明）
  const destination = user === undefined ? host : `${user}@${host}`;
  return { command: 'ssh', args: ['-p', String(port), '--', destination, ...tokens] };
}

/** 执行一条已放行的行动：先落 executing + exec-started，再执行，最后落结果与终态 */
export async function executeAction(
  action: ActionCore,
  actor: { readonly type: 'human' | 'agent'; readonly id: string },
): Promise<Execution> {
  setActionStatus(action.id, 'executing');
  insertEvent(action.id, 'exec-started', actor);
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  let timedOut = false;
  let durationMs = 0;
  let errorMessage: string | undefined;
  let ok = false;
  try {
    const spec = buildExecSpec(action);
    const result = await execute(spec.command, spec.args);
    ok = true;
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
    durationMs = result.durationMs;
  } catch (error) {
    if (isSkyportError(error)) {
      errorMessage = `${error.type}: ${error.message}`;
      timedOut = error.type === ERROR_CODES.EXEC_TIMEOUT;
      const recorded = error.context.exitCode;
      exitCode = typeof recorded === 'number' ? recorded : undefined;
      const recordedStderr = error.context.stderr;
      if (typeof recordedStderr === 'string') stderr = recordedStderr;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    } else {
      errorMessage = String(error);
    }
    rootLogger.warn('行动执行失败', { actionId: action.id, error: errorMessage });
  }
  const now = new Date().toISOString();
  const insert = getDb()
    .prepare(
      `INSERT INTO executions (action_id, ok, stdout, stderr, exit_code, timed_out, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(action.id, ok ? 1 : 0, stdout, stderr, exitCode ?? null, timedOut ? 1 : 0, durationMs, errorMessage ?? null, now);
  setActionStatus(action.id, ok ? 'success' : 'failed');
  insertEvent(action.id, 'exec-finished', actor, { ok, exitCode: exitCode ?? null, durationMs, timedOut });
  return {
    id: Number(insert.lastInsertRowid),
    actionId: action.id,
    ok,
    stdout,
    stderr,
    exitCode,
    timedOut,
    durationMs,
    error: errorMessage,
    createdAt: now,
  };
}

export function getLastExecution(actionId: string): Execution | undefined {
  const row = getDb()
    .prepare('SELECT * FROM executions WHERE action_id = ? ORDER BY id DESC LIMIT 1')
    .get(actionId) as ExecutionRow | undefined;
  if (row === undefined) return undefined;
  return rowToExecution(row);
}

function rowToExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    actionId: row.action_id,
    ok: row.ok === 1,
    stdout: row.stdout,
    stderr: row.stderr,
    exitCode: row.exit_code ?? undefined,
    timedOut: row.timed_out === 1,
    durationMs: row.duration_ms,
    error: row.error ?? undefined,
    createdAt: row.created_at,
  };
}

function setActionStatus(actionId: string, status: string): void {
  getDb()
    .prepare('UPDATE actions SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), actionId);
}

/** 事件只增不改：状态迁移的审计源 */
export function insertEvent(
  actionId: string,
  event: string,
  actor: { readonly type: 'human' | 'agent'; readonly id: string },
  detail?: Readonly<Record<string, unknown>>,
): void {
  getDb()
    .prepare('INSERT INTO action_events (action_id, event, actor_type, actor_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actionId, event, actor.type, actor.id, detail === undefined ? null : JSON.stringify(detail), new Date().toISOString());
}
