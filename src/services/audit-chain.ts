/**
 * 审计链防篡改（spec/audit-chain/spec.md）：事件枚举 + 全局单调序号 + 哈希链。
 * 红队 F2 的正面解法——任何单条删改都会断链，`skyport audit verify` 一条命令校验。
 */
import { createHash } from 'node:crypto';
import { getDb } from '../adapters/db';

/** 事件名枚举（TS 编译期约束，防拼写错——原来 insertEvent 第二参是裸字符串） */
export const ACTION_EVENT_TYPES = [
  'created',
  'auto-approved',
  'approved',
  'direct-run',
  'rejected',
  'cancelled',
  'expired',
  'exec-started',
  'exec-finished',
] as const;
export type ActionEventType = (typeof ACTION_EVENT_TYPES)[number];

export function isActionEventType(value: string): value is ActionEventType {
  return (ACTION_EVENT_TYPES as readonly string[]).includes(value);
}

export type ChainActorType = 'human' | 'agent' | 'system';

/** 执行记录的链化内容（append / backfill / verify 三处共用，保证哈希口径一致） */
function executionChainContent(row: {
  action_id: string;
  ok: number;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: number;
  duration_ms: number;
  attempts: number;
  stdout_truncated: number | null;
  stderr_truncated: number | null;
  error: string | null;
}): Record<string, unknown> {
  return {
    actionId: row.action_id,
    ok: row.ok === 1,
    stdout: row.stdout,
    stderr: row.stderr,
    exitCode: row.exit_code,
    timedOut: row.timed_out === 1,
    durationMs: row.duration_ms,
    attempts: row.attempts,
    error: row.error,
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
  };
}

/** 事件记录的链化内容（append / backfill / verify 三处共用） */
function eventChainContent(row: {
  action_id: string;
  event: string;
  actor_type: string;
  actor_id: string;
  detail: string | null;
}): Record<string, unknown> {
  // detail 解析失败（被事后篡改成非法 JSON）不抛异常：保留原串参与哈希重算，verify 自然报不匹配
  let detail: unknown = row.detail;
  if (row.detail !== null) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      // 保留原串
    }
  }
  return {
    actionId: row.action_id,
    event: row.event,
    actorType: row.actor_type,
    actorId: row.actor_id,
    detail,
  };
}

/** 计算一条记录的链式哈希：SHA-256(前条哈希 + 本条内容) */
export function computeChainHash(prevHash: string | null, content: Record<string, unknown>): string {
  const canonical = JSON.stringify(content, Object.keys(content).sort());
  return createHash('sha256').update(`${prevHash ?? 'GENESIS'}|${canonical}`).digest('hex');
}

/** 获取某表当前链尾（最近一条的 hash + seq），作为新记录的前驱 */
function getChainTail(table: 'action_events' | 'executions'): { hash: string | null; seq: number } {
  const row = getDb()
    .prepare(`SELECT hash, seq FROM ${table} WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1`)
    .get() as { hash: string | null; seq: number | null } | undefined;
  return { hash: row?.hash ?? null, seq: row?.seq ?? 0 };
}

/** 写入一条带链式哈希的审计记录（在事务内由调用方保证原子性） */
export function appendChainedEvent(
  actionId: string,
  event: ActionEventType,
  actorType: ChainActorType,
  actorId: string,
  detail?: Readonly<Record<string, unknown>>,
): void {
  const db = getDb();
  const tail = getChainTail('action_events');
  const seq = tail.seq + 1;
  const content = { actionId, event, actorType, actorId, detail: detail ?? null };
  const hash = computeChainHash(tail.hash, content);
  db.prepare(
    'INSERT INTO action_events (action_id, event, actor_type, actor_id, detail, created_at, seq, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(actionId, event, actorType, actorId, detail === undefined ? null : JSON.stringify(detail), new Date().toISOString(), seq, tail.hash, hash);
}

/** 写入一条带链式哈希的执行记录 */
export function appendChainedExecution(
  actionId: string,
  execContent: {
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    attempts: number;
    stdoutTruncated?: boolean | undefined;
    stderrTruncated?: boolean | undefined;
    error: string | null;
  },
): number {
  const db = getDb();
  const tail = getChainTail('executions');
  const seq = tail.seq + 1;
  const content = executionChainContent({
    action_id: actionId,
    ok: execContent.ok ? 1 : 0,
    stdout: execContent.stdout,
    stderr: execContent.stderr,
    exit_code: execContent.exitCode,
    timed_out: execContent.timedOut ? 1 : 0,
    duration_ms: execContent.durationMs,
    attempts: execContent.attempts,
    stdout_truncated: (execContent.stdoutTruncated ?? false) ? 1 : 0,
    stderr_truncated: (execContent.stderrTruncated ?? false) ? 1 : 0,
    error: execContent.error,
  });
  const hash = computeChainHash(tail.hash, content);
  const insert = db
    .prepare(
      `INSERT INTO executions (action_id, ok, stdout, stderr, exit_code, timed_out, duration_ms, attempts, stdout_truncated, stderr_truncated, error, created_at, seq, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      actionId,
      execContent.ok ? 1 : 0,
      execContent.stdout,
      execContent.stderr,
      execContent.exitCode,
      execContent.timedOut ? 1 : 0,
      execContent.durationMs,
      execContent.attempts,
      (execContent.stdoutTruncated ?? false) ? 1 : 0,
      (execContent.stderrTruncated ?? false) ? 1 : 0,
      execContent.error,
      new Date().toISOString(),
      seq,
      tail.hash,
      hash,
    );
  return Number(insert.lastInsertRowid);
}

export interface AuditVerifyResult {
  readonly ok: boolean;
  readonly checked: number;
  /** 存量未链化记录数（红队 V3）：这些行的删改不在链保护范围内 */
  readonly unchained: number;
  readonly firstViolation?: { readonly table: string; readonly seq: number; readonly reason: string };
}

/**
 * 校验审计链完整性（spec/audit-chain）：按各自 seq 排序，重算每条内容哈希并校验 prev_hash 链接。
 * 未链化的存量行不计入 checked，单独立计 unchained——"链完整"不再掩盖空链/半链。
 */
export function verifyAuditChain(): AuditVerifyResult {
  const db = getDb();
  let totalChecked = 0;
  let totalUnchained = 0;

  for (const table of ['action_events', 'executions'] as const) {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE seq IS NOT NULL ORDER BY seq ASC`)
      .all() as Record<string, unknown>[];
    const unchained = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE seq IS NULL`).get() as { n: number }
    ).n;
    totalUnchained += unchained;
    let expectedPrev: string | null = null;
    let expectedSeq = 0;
    for (const row of rows) {
      const seq = Number(row.seq);
      totalChecked += 1;
      expectedSeq += 1;
      if (seq !== expectedSeq) {
        return {
          ok: false,
          checked: totalChecked,
          unchained: totalUnchained,
          firstViolation: { table, seq, reason: `序号不连续（期望 ${expectedSeq}，实际 ${seq}——可能整段被删）` },
        };
      }
      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          checked: totalChecked,
          unchained: totalUnchained,
          firstViolation: {
            table,
            seq,
            reason: `前驱哈希不匹配（期望 ${expectedPrev?.slice(0, 12) ?? 'null'}，实际 ${String(row.prev_hash)?.slice(0, 12) ?? 'null'}）`,
          },
        };
      }
      const content = table === 'action_events' ? eventChainContent(row as never) : executionChainContent(row as never);
      const recomputed = computeChainHash(expectedPrev, content);
      if (recomputed !== row.hash) {
        return {
          ok: false,
          checked: totalChecked,
          unchained: totalUnchained,
          firstViolation: { table, seq, reason: '内容哈希不匹配（记录被事后篡改）' },
        };
      }
      expectedPrev = row.hash as string | null;
    }
  }
  return { ok: true, checked: totalChecked, unchained: totalUnchained };
}

export interface BackfillResult {
  readonly chainedEvents: number;
  readonly chainedExecutions: number;
}

/**
 * 存量行回填链化（红队 V3）：把 seq IS NULL 的历史记录按 id 顺序接到当前链尾。
 * 幂等——已是链化的行不动；整个回填在一个事务里，进程崩溃不产生半链。
 */
export function backfillAuditChain(): BackfillResult {
  const db = getDb();
  const result = { chainedEvents: 0, chainedExecutions: 0 };
  db.transaction(() => {
    for (const [table, toContent, counter] of [
      ['action_events', eventChainContent, 'chainedEvents'],
      ['executions', executionChainContent, 'chainedExecutions'],
    ] as const) {
      const tail = getChainTail(table);
      let prevHash = tail.hash;
      let seq = tail.seq;
      const rows = db
        .prepare(`SELECT * FROM ${table} WHERE seq IS NULL ORDER BY id ASC`)
        .all() as Record<string, unknown>[];
      const update = db.prepare(`UPDATE ${table} SET seq = ?, prev_hash = ?, hash = ? WHERE id = ?`);
      for (const row of rows) {
        seq += 1;
        const hash = computeChainHash(prevHash, toContent(row as never));
        update.run(seq, prevHash, hash, row.id as number | string);
        prevHash = hash;
        result[counter] += 1;
      }
    }
  })();
  return result;
}
