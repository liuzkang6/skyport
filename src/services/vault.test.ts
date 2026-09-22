import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { DATA_DIR, resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { getDb } from '../adapters/db';
import { getSecret, hasSecretRefs, listSecrets, removeSecret, resolveSecretRefs, setSecret } from './vault';
import { unlinkSync, existsSync } from 'node:fs';

let tempDir: string;
const vaultKey = join(DATA_DIR, 'vault.key');

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-vault-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  // 清理可能生成的 vault.key
  if (existsSync(vaultKey)) unlinkSync(vaultKey);
  await rm(tempDir, { recursive: true, force: true });
});

function cap(fn: () => unknown): string {
  try { fn(); } catch (e) { if (isSkyportError(e)) return e.type; throw e; }
  throw new Error('应抛错');
}

describe('凭证保险箱（PRD §2）', () => {
  it('正常路径：set→get 往返一致，hint 只显尾4位', () => {
    setSecret('aliyun_key', 'AKIA1234567890abcdef');
    const secret = getSecret('aliyun_key');
    expect(secret.value).toBe('AKIA1234567890abcdef');
    expect(secret.hint).toBe('****cdef');
    expect(secret.version).toBe(1);
  });

  it('加密验证：库中不存明文', () => {
    setSecret('password', 'SuperSecret999');
    const row = getDb().prepare('SELECT encrypted_value FROM secrets WHERE name = ?').get('password');
    expect(JSON.stringify(row)).not.toContain('SuperSecret999');
  });

  it('版本递增：更新后 version+1，值正确', () => {
    setSecret('token', 'old_value');
    setSecret('token', 'new_value');
    const secret = getSecret('token');
    expect(secret.value).toBe('new_value');
    expect(secret.version).toBe(2);
  });

  it('注入式引用：resolveSecretRefs 解析 {{secret:name}}', () => {
    setSecret('db_pass', 'MyDbPass123');
    const resolved = resolveSecretRefs('mysql -u admin -p{{secret:db_pass}} -e "SELECT 1"');
    expect(resolved).toBe('mysql -u admin -pMyDbPass123 -e "SELECT 1"');
  });

  it('引用检测：hasSecretRefs 正确识别', () => {
    expect(hasSecretRefs('echo {{secret:foo}}')).toBe(true);
    expect(hasSecretRefs('echo hello')).toBe(false);
  });

  it('失败路径-不存在的 secret：get/resolve/remove 均 ASSET_NOT_FOUND', () => {
    expect(cap(() => getSecret('ghost'))).toBe('SKYPORT_ASSET_NOT_FOUND');
    expect(cap(() => resolveSecretRefs('{{secret:ghost}}'))).toBe('SKYPORT_ASSET_NOT_FOUND');
    expect(cap(() => removeSecret('ghost'))).toBe('SKYPORT_ASSET_NOT_FOUND');
  });

  it('列表：只返回 hint 不返回值', () => {
    setSecret('a', 'value_a');
    setSecret('b', 'value_b');
    const secrets = listSecrets();
    expect(secrets).toHaveLength(2);
    expect(JSON.stringify(secrets)).not.toContain('value_a');
    expect(JSON.stringify(secrets)).not.toContain('value_b');
  });

  it('删除：remove 后不可再 get', () => {
    setSecret('temp', 'xyz');
    removeSecret('temp');
    expect(cap(() => getSecret('temp'))).toBe('SKYPORT_ASSET_NOT_FOUND');
  });
});
