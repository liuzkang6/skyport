/**
 * 凭证保险箱（PRD §2 关键机制）：AES-256-GCM 加密存储 + 注入式引用。
 * 密钥来源：~/.skyport/vault.key（0600），首次使用自动生成。
 * 注入式用法：行动单里写 {{secret:name}}，executor spawn 时解析→注入 env→即弃，
 * 凭证不进命令文本/日志/审计/通知（比 webhook 脱敏正则彻底）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../adapters/db';
import { DATA_DIR, getConfig } from '../config/config';
import { createError, ERROR_CODES } from '../errors/errors';
import { rootLogger } from '../logger/logger';

export interface SecretRecord {
  readonly id: string;
  readonly name: string;
  readonly hint: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredSecret extends SecretRecord {
  readonly value: string;
}

/** 密钥文件路径：~/.skyport/vault.key（与 DATA_DIR 同域，0600） */
function vaultKeyPath(): string {
  return join(DATA_DIR, 'vault.key');
}

/** 获取或生成主密钥（32 字节 = AES-256） */
function getOrCreateMasterKey(): Buffer {
  const path = vaultKeyPath();
  if (!existsSync(path)) {
    const key = randomBytes(32);
    writeFileSync(path, key, { mode: 0o600 });
    chmodSync(path, 0o600);
    rootLogger.info('已生成保险箱主密钥', { path });
    return key;
  }
  const key = readFileSync(path);
  if (key.length !== 32) {
    throw createError(ERROR_CODES.CONFIG_INVALID, `保险箱主密钥长度异常（${key.length} 字节，应为 32）`, { context: { path } });
  }
  return key;
}

function encrypt(value: string): { encrypted: string; iv: string; authTag: string } {
  const key = getOrCreateMasterKey();
  const iv = randomBytes(12); // GCM 标准 96 位
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getOrCreateMasterKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

export function setSecret(name: string, value: string): SecretRecord {
  if (name.length === 0 || name.length > 100) {
    throw createError(ERROR_CODES.ASSET_INVALID, 'secret 名长度需在 1-100 之间');
  }
  if (value.length === 0 || value.length > 10_000) {
    throw createError(ERROR_CODES.ASSET_INVALID, 'secret 值不能为空且不超过 10000 字符');
  }
  const { encrypted, iv, authTag } = encrypt(value);
  const now = new Date().toISOString();
  const existing = getDb().prepare('SELECT id, version FROM secrets WHERE name = ?').get(name) as { id: string; version: number } | undefined;

  if (existing) {
    getDb().prepare('UPDATE secrets SET encrypted_value = ?, iv = ?, auth_tag = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(encrypted, iv, authTag, now, existing.id);
    return { id: existing.id, name, hint: hintOf(value), version: existing.version + 1, createdAt: now, updatedAt: now };
  }
  const id = `sec_${randomBytes(4).toString('hex')}`;
  getDb().prepare('INSERT INTO secrets (id, name, encrypted_value, iv, auth_tag, hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, encrypted, iv, authTag, hintOf(value), now, now);
  return { id, name, hint: hintOf(value), version: 1, createdAt: now, updatedAt: now };
}

export function getSecret(name: string): StoredSecret {
  const row = getDb().prepare('SELECT * FROM secrets WHERE name = ?').get(name) as SecretRow | undefined;
  if (row === undefined) throw createError(ERROR_CODES.ASSET_NOT_FOUND, `secret 不存在: ${name}`, { context: { name } });
  const value = decrypt(row.encrypted_value, row.iv, row.auth_tag);
  return { id: row.id, name: row.name, hint: row.hint, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, value };
}

export function listSecrets(): SecretRecord[] {
  return (getDb().prepare('SELECT id, name, hint, version, created_at, updated_at FROM secrets ORDER BY name').all() as SecretRow[])
    .map((row) => ({ id: row.id, name: row.name, hint: row.hint, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export function removeSecret(name: string): void {
  const result = getDb().prepare('DELETE FROM secrets WHERE name = ?').run(name);
  if (result.changes === 0) throw createError(ERROR_CODES.ASSET_NOT_FOUND, `secret 不存在: ${name}`);
}

/** 解析行动单命令/环境中的 {{secret:name}} 引用（注入式用法核心） */
export function resolveSecretRefs(text: string): string {
  return text.replace(/\{\{secret:([^}]+)\}\}/g, (_, name: string) => {
    try {
      return getSecret(name.trim()).value;
    } catch (error) {
      rootLogger.warn('secret 引用解析失败', { name, error: error instanceof Error ? error.message : String(error) });
      throw createError(ERROR_CODES.ASSET_NOT_FOUND, `secret 引用无法解析: ${name}`, { cause: error, context: { name } });
    }
  });
}

/** 检查文本中是否包含 secret 引用（dry-run 时提示用） */
export function hasSecretRefs(text: string): boolean {
  return /\{\{secret:[^}]+\}\}/.test(text);
}

/** 值的提示（尾4位，中间星号）——永远不在日志/审计/通知中显示完整值 */
function hintOf(value: string): string {
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

interface SecretRow {
  id: string; name: string; encrypted_value: string; iv: string; auth_tag: string; hint: string; version: number; created_at: string; updated_at: string;
}
