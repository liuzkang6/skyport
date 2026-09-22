import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { backupDatabase } from './backup';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-backup-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('backup 数据库备份', () => {
  it('正常路径：自定义目录备份 → 文件是合法 SQLite 且 schema_version 与主库一致', async () => {
    const result = await backupDatabase(join(tempDir, 'bak'));
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.pruned).toBe(0);
    const copy = new Database(result.path);
    const row = copy.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(3);
    copy.close();
  });

  it('保留策略：keep=2 下旧备份被清理并计数（按 mtime 新→旧保留）', async () => {
    const dir = join(tempDir, 'bak2');
    mkdirSync(dir, { recursive: true });
    const now = Date.now() / 1000;
    for (const [index, name] of ['skyport-old-a.db', 'skyport-old-b.db', 'skyport-old-c.db'].entries()) {
      writeFileSync(join(dir, name), 'x');
      utimesSync(join(dir, name), now - (10 - index), now - (10 - index));
    }
    const result = await backupDatabase(dir, 2);
    expect(result.pruned).toBe(2); // 3 份旧的 + 1 份新的，保留 2 → 清 2
  });

  it('权限边界：默认目录 0700 / 文件 0600；自定义目录不动权限（S5 规矩）', async () => {
    const custom = join(tempDir, 'shared');
    mkdirSync(custom, { mode: 0o755 });
    chmodSync(custom, 0o755);
    await backupDatabase(custom);
    expect((await stat(custom)).mode & 0o777).toBe(0o755);
    // 默认目录走 DATA_DIR：验证权限后立即清理，不污染真实备份目录
    const result = await backupDatabase(undefined, 0);
    try {
      expect((await stat(join(result.path, '..'))).mode & 0o777).toBe(0o700);
      expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(result.path, { force: true });
    }
  });
});
