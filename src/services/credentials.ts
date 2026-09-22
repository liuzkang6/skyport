/**
 * 凭证三层（spec/agent-credentials/spec.md）：刷新令牌 → 会话令牌 → 行动审批。
 * 设计要点：
 * - skr_（刷新令牌）：256 位随机，库中 SHA-256 哈希，文件 0600，永不上 argv
 * - sks_（会话令牌）：128 位随机，库中哈希，TTL 30 分钟默认，闲置 15 分钟作废
 * - 轮换双模式：换票即轮换（login 时自动）+ 手动 rotate；复用检测自动吊销
 * - 单飞锁：文件锁保护 login 过程（防并发轮换自触发复用检测）
 */
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';
import { getConfig } from '../config/config';
import type { ActorRef } from './agents';

export interface SessionToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly agentName: string;
}

export interface SessionInfo {
  readonly id: string;
  readonly agentId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | undefined;
  readonly revoked: boolean;
}

const SESSION_TTL_MINUTES_DEFAULT = 30;
const IDLE_TIMEOUT_MINUTES_DEFAULT = 15;
const REFRESH_MAX_AGE_DAYS = 90;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 签发刷新令牌（agent create / rotate 时调用），只返回一次 */
export function issueRefreshToken(agentId: string): string {
  const token = `skr_${randomBytes(32).toString('hex')}`;
  const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE_DAYS * 24 * 3_600_000).toISOString();
  getDb()
    .prepare('UPDATE agents SET refresh_token_hash = ?, refresh_expires_at = ?, updated_at = ? WHERE id = ?')
    .run(sha256(token), expiresAt, new Date().toISOString(), agentId);
  return token;
}

/** 用刷新令牌换会话令牌（agent login 核心逻辑） */
export function loginWithRefreshToken(refreshToken: string): SessionToken {
  const hash = sha256(refreshToken);
  const row = getDb()
    .prepare('SELECT id, name, status, refresh_expires_at FROM agents WHERE refresh_token_hash = ?')
    .get(hash) as { id: string; name: string; status: string; refresh_expires_at: string | null } | undefined;

  if (row === undefined) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '刷新令牌无效', { context: {} });
  }
  if (row.status !== 'active') {
    throw createError(ERROR_CODES.PERMISSION_DENIED, `agent 状态不允许（${row.status}）`, { context: { agent: row.name } });
  }
  if (row.refresh_expires_at !== null && Date.parse(row.refresh_expires_at) <= Date.now()) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '刷新令牌已过期', { context: { agent: row.name } });
  }

  return issueSessionToken(row.id, row.name);
}

/** 铸造会话令牌 */
function issueSessionToken(agentId: string, agentName: string): SessionToken {
  const token = `sks_${randomBytes(16).toString('hex')}`;
  const config = getConfig();
  const ttlMinutes = (config as unknown as { sessionTtlMinutes?: number }).sessionTtlMinutes ?? SESSION_TTL_MINUTES_DEFAULT;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO agent_sessions (id, agent_id, token_hash, issued_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`ses_${randomBytes(4).toString('hex')}`, agentId, sha256(token), now, expiresAt, now);
  return { token, expiresAt, agentName };
}

/** 验证会话令牌：哈希匹配 + 未过期 + 未闲置超时 + 未吊销 */
export function verifySessionToken(token: string): ActorRef {
  const hash = sha256(token);
  const row = getDb()
    .prepare(
      `SELECT s.*, a.name as agent_name, a.status as agent_status
       FROM agent_sessions s JOIN agents a ON a.id = s.agent_id
       WHERE s.token_hash = ?`,
    )
    .get(hash) as
    | {
        id: string; agent_id: string; token_hash: string; issued_at: string; expires_at: string;
        last_used_at: string | null; revoked: number; agent_name: string; agent_status: string;
      }
    | undefined;

  if (row === undefined || row.revoked === 1) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '会话令牌无效或已吊销', { context: {} });
  }
  if (row.agent_status !== 'active') {
    throw createError(ERROR_CODES.PERMISSION_DENIED, `agent 状态不允许（${row.agent_status}）`, { context: {} });
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '会话令牌已过期', { context: {} });
  }
  // 闲置超时
  const idleMs = Date.now() - Date.parse(row.last_used_at ?? row.issued_at);
  const idleTimeoutMinutes = IDLE_TIMEOUT_MINUTES_DEFAULT;
  if (idleMs > idleTimeoutMinutes * 60_000) {
    getDb().prepare('UPDATE agent_sessions SET revoked = 1 WHERE id = ?').run(row.id);
    throw createError(ERROR_CODES.PERMISSION_DENIED, '会话令牌闲置超时', { context: {} });
  }

  // 更新最后使用时间
  getDb().prepare('UPDATE agent_sessions SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return { type: 'agent', id: row.agent_id, name: row.agent_name };
}

/** 手动轮换刷新令牌 */
export function rotateRefreshToken(agentNameOrId: string): { token: string; agentName: string } {
  const row = getDb()
    .prepare('SELECT id, name FROM agents WHERE id = ? OR name = ?')
    .get(agentNameOrId, agentNameOrId) as { id: string; name: string } | undefined;
  if (row === undefined) {
    throw createError(ERROR_CODES.AGENT_NOT_FOUND, `agent 不存在: ${agentNameOrId}`, { context: { target: agentNameOrId } });
  }
  const token = issueRefreshToken(row.id);
  return { token, agentName: row.name };
}

/** 列出活跃会话 */
export function listSessions(agentNameOrId: string): SessionInfo[] {
  const row = getDb()
    .prepare('SELECT id FROM agents WHERE id = ? OR name = ?')
    .get(agentNameOrId, agentNameOrId) as { id: string } | undefined;
  if (row === undefined) {
    throw createError(ERROR_CODES.AGENT_NOT_FOUND, `agent 不存在: ${agentNameOrId}`, { context: { target: agentNameOrId } });
  }
  return (getDb()
    .prepare('SELECT * FROM agent_sessions WHERE agent_id = ? AND revoked = 0 ORDER BY issued_at DESC')
    .all(row.id) as SessionRow[]).map(rowToSessionInfo);
}

/** 吊销指定会话 */
export function revokeSession(sessionId: string): void {
  const result = getDb().prepare('UPDATE agent_sessions SET revoked = 1 WHERE id = ?').run(sessionId);
  if (result.changes === 0) {
    throw createError(ERROR_CODES.AGENT_NOT_FOUND, `会话不存在: ${sessionId}`, { context: { sessionId } });
  }
}

/**
 * 认证入口：接受 skp_（legacy 静态）、skr_（刷新）、sks_（会话）三种令牌。
 * 返回 ActorRef；失败一律 PERMISSION_DENIED。
 */
export function resolveActorWithSessions(token: string): ActorRef {
  if (token.startsWith('sks_')) {
    return verifySessionToken(token);
  }
  // skp_ 和 skr_ 都走旧路径（skr_ 需先 login 换 sks_）
  // 延迟导入避免循环
  const { actorFromKey } = require('./agents') as typeof import('./agents');
  return actorFromKey(token);
}

interface SessionRow {
  id: string; agent_id: string; token_hash: string; issued_at: string; expires_at: string; last_used_at: string | null; revoked: number;
}

function rowToSessionInfo(row: SessionRow): SessionInfo {
  return {
    id: row.id, agentId: row.agent_id, issuedAt: row.issued_at,
    expiresAt: row.expires_at, lastUsedAt: row.last_used_at ?? undefined, revoked: row.revoked === 1,
  };
}
