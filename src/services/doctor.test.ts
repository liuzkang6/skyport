import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { runDoctor } from './doctor';

let tempDir: string;

beforeEach(async () => {
  // doctor 现在会打开数据库：把库指到临时目录，避免测试污染真实 ~/.skyport
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-doctor-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('doctor 环境自检服务', () => {
  it('正常路径：本机 node 可用、配置可加载、数据库就绪，整体通过', async () => {
    const report = await runDoctor();
    expect(report.ok).toBe(true);
    const names = report.checks.map((check) => check.name);
    expect(names).toContain('node-runtime');
    expect(names).toContain('config');
    expect(names).toContain('project-config-file');
    expect(names).toContain('database');
  });
});
