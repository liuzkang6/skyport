/**
 * Web 用户与角色四分（spec/webui）：viewer ⊂ operator ⊂ approver ⊂ admin。
 * 密码 scrypt 哈希（库中只存 salt+hash）；Web 会话令牌 skw_（哈希落库，12h 有效 / 2h 闲置作废）。
 * 登录失败统一文案防枚举；连续失败 5 次锁 5 分钟（per-username）。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';

export const USER_ROLES = ['viewer', 'operator', 'approver', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const WEB_SESSION_COOKIE = 'skyport_session';
const WEB_SESSION_TTL_MS = 12 * 3_600_000;
const WEB_SESSION_IDLE_MS = 2 * 3_600_000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 5 * 60_000;

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-_]{1,31}$/;
const PASSWORD_MIN_LENGTH = 8;

/** 能力按角色递增：viewer ⊂ operator ⊂ approver ⊂ admin（spec 接口节的端点门禁查这里） */
export const ROLE_CAPABILITIES: Readonly<Record<UserRole, readonly string[]>> = {
  viewer: ['read'],
  operator: ['read', 'action:create'],
  approver: ['read', 'action:create', 'action:approve', 'alerts:write'],
  admin: ['read', 'action:create', 'action:approve', 'alerts:write', 'users:manage'],
};

export function can(role: UserRole, capability: string): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export interface User {
  readonly id: string;
  readonly name: string;
  readonly role: UserRole;
  readonly status: 'active' | 'disabled';
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface UserRow {
  id: string; name: string; password_salt: string; password_hash: string; role: string;
  status: string; failed_attempts: number; locked_until: string | null; created_at: string; updated_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id, name: row.name, role: row.role as UserRole,
    status: row.status as 'active' | 'disabled', createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 创建用户（admin 命令行管理；重名/非法用户名/非法角色/弱密码各自报错） */
export function createUser(name: string, password: string, role: UserRole): User {
  if (!USERNAME_PATTERN.test(name)) {
    throw createError(ERROR_CODES.USER_INVALID, '用户名非法（小写字母/数字/-/_，2~32 位）', { context: { name } });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw createError(ERROR_CODES.USER_INVALID, `密码至少 ${PASSWORD_MIN_LENGTH} 个字符`, { context: {} });
  }
  if (!USER_ROLES.includes(role)) {
    throw createError(ERROR_CODES.USER_INVALID, `非法角色: ${role}（可选 ${USER_ROLES.join('/')}）`, { context: { role } });
  }
  const exists = getDb().prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (exists !== undefined) {
    throw createError(ERROR_CODES.USER_DUPLICATE_NAME, `用户已存在: ${name}`, { context: { name } });
  }
  const now = new Date().toISOString();
  const salt = randomBytes(16).toString('hex');
  const user: User = { id: `usr_${randomBytes(6).toString('hex')}`, name, role, status: 'active', createdAt: now, updatedAt: now };
  getDb()
    .prepare('INSERT INTO users (id, name, password_salt, password_hash, role, status, failed_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(user.id, name, salt, hashPassword(password, salt), role, 'active', now, now);
  return user;
}

/** 用户清单（不含盐与哈希） */
export function listUsers(): User[] {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
  return rows.map(toUser);
}

/**
 * 登录校验：成功返回 User 并清零失败计数；失败统一 PERMISSION_DENIED（防枚举）；
 * 锁定中 USER_LOCKED（可重试）；禁用 USER_DISABLED。
 */
export function verifyLogin(name: string, password: string): User {
  const row = getDb().prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRow | undefined;
  const genericDeny = () =>
    createError(ERROR_CODES.PERMISSION_DENIED, '用户名或密码错误', { context: {} });

  if (row === undefined) {
    // 仍做一次哈希运算，拉平"用户不存在"与"密码错误"的响应时间
    hashPassword(password, 'decoy-salt');
    throw genericDeny();
  }
  if (row.locked_until !== null && Date.parse(row.locked_until) > Date.now()) {
    throw createError(ERROR_CODES.USER_LOCKED, `失败次数过多，锁定至 ${row.locked_until}`, { context: { name }, retryable: true });
  }
  if (!verifyPassword(password, row.password_salt, row.password_hash)) {
    const attempts = row.failed_attempts + 1;
    const lockedUntil = attempts >= LOGIN_MAX_FAILURES ? new Date(Date.now() + LOGIN_LOCK_MS).toISOString() : null;
    getDb()
      .prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
      .run(attempts, lockedUntil, new Date().toISOString(), row.id);
    throw genericDeny();
  }
  if (row.status !== 'active') {
    throw createError(ERROR_CODES.USER_DISABLED, `用户已禁用: ${name}`, { context: { name } });
  }
  if (row.failed_attempts !== 0 || row.locked_until !== null) {
    getDb().prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);
  }
  return toUser(row);
}

export interface WebSession {
  readonly token: string;
  readonly user: User;
  readonly expiresAt: string;
}

/** 签发 Web 会话（skw_ 前缀，明文只返回一次，库中哈希） */
export function issueWebSession(user: User): WebSession {
  const token = `skw_${randomBytes(32).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + WEB_SESSION_TTL_MS).toISOString();
  getDb()
    .prepare('INSERT INTO web_sessions (id, user_id, token_hash, issued_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`ws_${randomBytes(6).toString('hex')}`, user.id, sha256(token), now.toISOString(), expiresAt, now.toISOString());
  return { token, user, expiresAt };
}

/**
 * 校验 Web 会话：哈希匹配 + 未过期 + 未闲置（2h）+ 用户仍 active。
 * 闲置超时即吊销；通过则滚动更新 last_used_at（唯一写路径）。
 */
export function verifyWebSession(token: string): User {
  const row = getDb()
    .prepare(
      `SELECT s.*, u.name AS user_name, u.role AS user_role, u.status AS user_status
       FROM web_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as
    | { id: string; user_id: string; issued_at: string; expires_at: string; last_used_at: string;
        user_name: string; user_role: string; user_status: string }
    | undefined;

  if (row === undefined) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '会话无效', { context: {} });
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    getDb().prepare('DELETE FROM web_sessions WHERE id = ?').run(row.id);
    throw createError(ERROR_CODES.PERMISSION_DENIED, '会话已过期', { context: {} });
  }
  if (Date.now() - Date.parse(row.last_used_at) > WEB_SESSION_IDLE_MS) {
    getDb().prepare('DELETE FROM web_sessions WHERE id = ?').run(row.id);
    throw createError(ERROR_CODES.PERMISSION_DENIED, '会话闲置超时', { context: {} });
  }
  if (row.user_status !== 'active') {
    throw createError(ERROR_CODES.USER_DISABLED, `用户已禁用: ${row.user_name}`, { context: { name: row.user_name } });
  }
  getDb().prepare('UPDATE web_sessions SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return {
    id: row.user_id, name: row.user_name, role: row.user_role as UserRole,
    status: 'active', createdAt: row.issued_at, updatedAt: row.issued_at,
  };
}

/** 吊销 Web 会话（登出）；令牌不存在不报错（幂等登出） */
export function revokeWebSession(token: string): void {
  getDb().prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(sha256(token));
}
