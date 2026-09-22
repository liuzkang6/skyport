/**
 * 红队 N1 回归：--json 大输出经管道必须完整送达。
 * 机理：process.exit 会丢弃未冲刷的异步管道写（恰好断在 64KiB）；改 exitCode 自然退出后应完整。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';

const execFileAsync = promisify(execFile);

let tempDir: string;
let dbPath: string;
const ROWS = 260; // 每行 JSON 约 350+ 字节，总量约 90KB，稳超 64KiB 管道缓冲

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-pipe-'));
  dbPath = join(tempDir, 'skyport.db');
  process.env.SKYPORT_DB_PATH = dbPath;
  resetConfigCache();
  const now = new Date().toISOString();
  const insert = getDb().prepare(
    `INSERT INTO actions (id, command, target_name, target_kind, risk_level, risk_source, status, actor_type, actor_id, created_at, updated_at)
     VALUES (?, ?, 'local', 'local', 'low', 'default-low', 'success', 'human', 'pipe-test', ?, ?)`,
  );
  for (let i = 0; i < ROWS; i += 1) {
    insert.run(`act_pipe${String(i).padStart(4, '0')}`, `echo ${'x'.repeat(120)}-${i}`, now, now);
  }
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('CLI 管道输出完整性（红队 N1）', () => {
  it('--json 大输出经管道完整送达且可解析（>64KiB）', { timeout: 60_000 }, async () => {
    const projectRoot = process.cwd();
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(projectRoot, 'src', 'cli', 'index.ts'),
        'action',
        'list',
        '--json',
        '--limit',
        '300',
      ],
      { env: { ...process.env, SKYPORT_DB_PATH: dbPath }, maxBuffer: 16 * 1024 * 1024 },
    );
    expect(Buffer.byteLength(stdout, 'utf8')).toBeGreaterThan(65_536);
    const page = JSON.parse(stdout) as { actions: unknown[] };
    expect(page.actions).toHaveLength(ROWS);
  });
});
