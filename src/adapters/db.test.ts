import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_DIR } from '../config/config';
import { openDatabase } from './db';
import { MIGRATIONS } from './migrations';

let tempDir: string;
let dbPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-db-'));
  dbPath = join(tempDir, 'nested', 'skyport.db');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('db 适配器（SQLite 底座）', () => {
  it('正常路径：打开即建库即迁移，三张表与版本号就绪', () => {
    const db = openDatabase(dbPath);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const tables = rows.map((row) => row.name);
    expect(tables).toContain('assets');
    expect(tables).toContain('asset_checks');
    expect(tables).toContain('schema_version');
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
    expect(row.v).toBe(MIGRATIONS.length);
    db.close();
  });

  it('幂等性：重复打开同一库不重复迁移（版本记录数 = 迁移数）', () => {
    const first = openDatabase(dbPath);
    first.close();
    const second = openDatabase(dbPath);
    const row = second.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number };
    expect(row.c).toBe(MIGRATIONS.length);
    second.close();
  });

  it('安全基线：默认数据目录 0700、库文件 0600（在 DATA_DIR 内建临时库验证后清理）', async () => {
    const db = openDatabase(join(DATA_DIR, `perm-test-${Date.now()}.db`));
    db.close();
    expect((await stat(DATA_DIR)).mode & 0o777).toBe(0o700);
    const files = (await readdir(DATA_DIR)).filter((name) => name.startsWith('perm-test-'));
    for (const name of files) {
      const file = join(DATA_DIR, name);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      rmSync(file, { force: true });
    }
  });

  it('红队 S5：自定义 dbPath 不 chmod 使用者目录（0755 保持不变），库仍可建可迁移', async () => {
    const customDir = join(tempDir, 'shared');
    mkdirSync(customDir, { mode: 0o755 });
    chmodSync(customDir, 0o755);
    const customPath = join(customDir, 'x.db');
    const db = openDatabase(customPath);
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
    expect(row.v).toBe(MIGRATIONS.length);
    db.close();
    expect((await stat(customDir)).mode & 0o777).toBe(0o755);
  });
});
