/**
 * 审计链防篡改（spec/audit-chain/spec.md）：事件枚举 + 全局单调序号 + 哈希链。
 * 红队 F2 的正面解法——任何单条删改都会断链，`skyport audit verify` 一条命令校验。
 */
import { createHash } from 'node:crypto';
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';

/** 事件名枚举（TS 编译期约束，防拼写错——原来 insertEvent 第二参是裸字符串） */
export const ACTION_EVENT_TYPES = [
  'created',
  'auto-approved',
  'approved',
  'direct-run',
  'rejected',
  'cancelled',
  'exec-started',
  'exec-finished',
] as const;
export type ActionEventType = (typeof ACTION_EVENT_TYPES)[number];

export function isActionEventType(value: string): value is ActionEventType {
  return (ACTION_EVENT_TYPES as readonly string[]).includes(value);
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
  actorType: 'human' | 'agent',
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
    error: string | null;
  },
): number {
  const db = getDb();
  const tail = getChainTail('executions');
  const seq = tail.seq + 1;
  const hash = computeChainHash(tail.hash, { actionId, ...execContent });
  const insert = db
    .prepare(
      `INSERT INTO executions (action_id, ok, stdout, stderr, exit_code, timed_out, duration_ms, attempts, error, created_at, seq, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  readonly firstViolation?: { readonly table: string; readonly seq: number; readonly reason: string };
}

/** 校验审计链完整性：遍历两表按各自 seq 排序，校验 prev_hash 链接 */
export function verifyAuditChain(): AuditVerifyResult {
  const db = getDb();
  let totalChecked = 0;

  for (const table of ['action_events', 'executions'] as const) {
    const rows = db
      .prepare(`SELECT seq, prev_hash, hash FROM ${table} WHERE seq IS NOT NULL ORDER BY seq ASC`)
      .all() as { seq: number; prev_hash: string | null; hash: string | null }[];
    let expectedPrev: string | null = null;
    for (const row of rows) {
      totalChecked += 1;
      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          checked: totalChecked,
          firstViolation: {
            table,
            seq: row.seq,
            reason: `前驱哈希不匹配（期望 ${expectedPrev?.slice(0, 12) ?? 'null'}，实际 ${row.prev_hash?.slice(0, 12) ?? 'null'}）`,
          },
        };
      }
      expectedPrev = row.hash;
    }
  }
  return { ok: true, checked: totalChecked };
}
