/**
 * 行动执行桥（M2/M3 + P1/S9/S10/S12 加固）：把一条行动解析成本机/SSH 目标，经唯一执行器执行并落审计。
 * 关键决定：
 * - 进入 executing 用原子 UPDATE 占位（红队 S10）：并发审批/竞态下只有一个进程能执行
 * - executions 如实记录总耗时、尝试次数、输出截断标志（红队 S9/S12）
 * - 执行不在 SQLite 事务里（executor 是异步的）——状态推进以事件流为准（spec 已注明）
 */
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { execute, type ExecResult } from '../executor/executor';
import { rootLogger } from '../logger/logger';
import { appendChainedEvent, appendChainedExecution, type ActionEventType, type ChainActorType } from './audit-chain';
import { getAsset, parseAddr } from './assets';
import { dispatchToAsset, isAssetChannelConnected, type AgentExecResult } from './agent-channel';
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
  readonly attempts: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
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
  attempts: number;
  stdout_truncated: number;
  stderr_truncated: number;
  error: string | null;
  created_at: string;
}

interface ExecSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** 原子状态迁移（红队 S10）：仅当行动仍处于 from 状态时迁移到 to，返回是否抢占成功 */
export function claimTransition(actionId: string, from: string, to: string): boolean {
  const result = getDb()
    .prepare('UPDATE actions SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(to, new Date().toISOString(), actionId, from);
  return result.changes > 0;
}

/**
 * 解析执行目标。
 * 关键决定（红队 N2）：
 * - 本地：tokenizeCommand 切成参数数组直 exec，不经 shell；
 * - SSH：**把入库的原始命令字符串原样作为单一参数**交给 ssh——远端 shell 解释的就是
 *   审批人读到的同一串字符，杜绝"本地剥引号→空格拼接→远端拆散"的语义变形
 *   （`touch "/tmp/a b.txt"` 不再变成创建两个文件）。
 * - 外层 ssh 固定 BatchMode=yes：密钥认证不弹交互，异常时快速失败而非挂到超时。
 */
export function buildExecSpec(action: ActionCore): ExecSpec {
  const tokens = tokenizeCommand(action.command);
  const head = tokens[0];
  if (head === undefined) {
    throw createError(ERROR_CODES.ACTION_INVALID, '命令切分后为空', { context: { command: action.command } });
  }
  if (action.targetKind === 'local') return { command: head, args: tokens.slice(1) };
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
  return {
    command: 'ssh',
    args: ['-p', String(port), '-o', 'BatchMode=yes', '--', destination, action.command],
  };
}

/** 目标资产有在线 agent 通道时经通道执行；无通道返回 undefined（走常规本地/SSH 路径） */
async function tryDispatchViaChannel(action: ActionCore): Promise<AgentExecResult | undefined> {
  if (action.targetKind !== 'ssh' || action.targetAssetId === undefined) return undefined;
  const asset = getAsset(action.targetAssetId);
  if (asset === undefined || !isAssetChannelConnected(asset.name)) return undefined;
  rootLogger.info('经 agent 反向通道执行', { actionId: action.id, asset: asset.name, command: action.command });
  return dispatchToAsset(asset.name, action.command);
}

/** 执行一条已放行的行动：原子占位 executing → 执行 → 落结果与终态 */
export async function executeAction(
  action: ActionCore,
  actor: { readonly type: 'human' | 'agent'; readonly id: string },
): Promise<Execution> {
  if (!claimTransition(action.id, 'approved', 'executing')) {
    const row = getDb().prepare('SELECT status FROM actions WHERE id = ?').get(action.id) as
      | { status: string }
      | undefined;
    throw createError(
      ERROR_CODES.ACTION_INVALID_STATE,
      `行动 ${action.id} 当前状态为 ${row?.status ?? '未知'}，不能执行（应为 approved）`,
      { context: { actionId: action.id, status: row?.status ?? 'unknown' } },
    );
  }
  insertEvent(action.id, 'exec-started', actor);
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  let timedOut = false;
  let durationMs = 0;
  let attempts = 1;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let errorMessage: string | undefined;
  let ok = false;
  try {
    // agent 反向通道优先（v0.4 收尾）：目标资产有在线 agent 通道时经通道下发，
    // 不再依赖网关直连 SSH；通道在线但执行失败就是失败——不回退（防同一命令双路径重复执行）
    const channelResult = await tryDispatchViaChannel(action);
    if (channelResult !== undefined) {
      ok = channelResult.ok;
      stdout = channelResult.stdout;
      stderr = channelResult.stderr;
      exitCode = channelResult.exitCode;
      timedOut = channelResult.timedOut;
      durationMs = channelResult.durationMs;
      if (!ok && !timedOut && channelResult.stderr !== '') errorMessage = channelResult.stderr;
    } else {
      const spec = buildExecSpec(action);
      const result: ExecResult = await execute(spec.command, spec.args);
      ok = true;
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
      durationMs = result.durationMs;
      attempts = result.attempts;
      stdoutTruncated = result.stdoutTruncated;
      stderrTruncated = result.stderrTruncated;
    }
  } catch (error) {
    if (isSkyportError(error)) {
      errorMessage = error.message;
      timedOut = error.type === ERROR_CODES.EXEC_TIMEOUT;
      const recordedExit = error.context.exitCode;
      exitCode = typeof recordedExit === 'number' ? recordedExit : undefined;
      const recordedStderr = error.context.stderr;
      if (typeof recordedStderr === 'string') stderr = recordedStderr;
      const recordedDuration = error.context.durationMs;
      durationMs = typeof recordedDuration === 'number' ? recordedDuration : 0;
      const recordedAttempts = error.context.attempts;
      attempts = typeof recordedAttempts === 'number' ? recordedAttempts : 1;
      stdoutTruncated = error.context.stdoutTruncated === true;
      stderrTruncated = error.context.stderrTruncated === true;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    } else {
      errorMessage = String(error);
    }
    rootLogger.warn('行动执行失败', { actionId: action.id, error: errorMessage, attempts });
  }
  const now = new Date().toISOString();
  // 红队 V3：执行记录经链化写入（seq/prev_hash/hash 全局单调链，verify 可检测任何删改）
  const insertId = appendChainedExecution(action.id, {
    ok,
    stdout,
    stderr,
    exitCode: exitCode ?? null,
    timedOut,
    durationMs,
    attempts,
    stdoutTruncated,
    stderrTruncated,
    error: errorMessage ?? null,
  });
  claimTransition(action.id, 'executing', ok ? 'success' : 'failed');
  insertEvent(action.id, 'exec-finished', actor, {
    ok,
    exitCode: exitCode ?? null,
    durationMs,
    attempts,
    timedOut,
  });
  return {
    id: insertId,
    actionId: action.id,
    ok,
    stdout,
    stderr,
    exitCode,
    timedOut,
    durationMs,
    attempts,
    stdoutTruncated,
    stderrTruncated,
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
    attempts: row.attempts,
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
    error: row.error ?? undefined,
    createdAt: row.created_at,
  };
}

/** 事件只增不改：状态迁移的审计源（红队 V3：一律链化写入，appendChainedEvent 是唯一实现） */
export function insertEvent(
  actionId: string,
  event: ActionEventType,
  actor: { readonly type: ChainActorType; readonly id: string },
  detail?: Readonly<Record<string, unknown>>,
): void {
  appendChainedEvent(actionId, event, actor.type, actor.id, detail);
}
