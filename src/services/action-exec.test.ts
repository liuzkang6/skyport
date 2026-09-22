/**
 * 红队 N2 回归：SSH 目标必须原样传命令字符串（审批人看到的语义 = 远端实际语义）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { addAsset } from './assets';
import { buildExecSpec, type ActionCore } from './action-exec';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-execspec-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

function coreOf(overrides: Partial<ActionCore>): ActionCore {
  return {
    id: 'act_testspec',
    command: 'echo hi',
    targetAssetId: undefined,
    targetName: 'local',
    targetKind: 'local',
    ...overrides,
  };
}

describe('执行目标解析（红队 N2）', () => {
  it('SSH：命令字符串原样作为单一参数（带空格的引号路径不再被拆散）+ BatchMode 防交互挂死', () => {
    const asset = addAsset({ name: 's1', type: 'host', addr: 'root@10.9.0.1' });
    const spec = buildExecSpec(
      coreOf({
        command: 'touch "/tmp/a b.txt"',
        targetAssetId: asset.id,
        targetName: 's1',
        targetKind: 'ssh',
      }),
    );
    expect(spec.command).toBe('ssh');
    expect(spec.args).toContain('BatchMode=yes');
    // 最后一个参数是完整原始命令字符串，而非被空格拆散的多个参数
    expect(spec.args[spec.args.length - 1]).toBe('touch "/tmp/a b.txt"');
    expect(spec.args[spec.args.length - 2]).toBe('root@10.9.0.1');
  });

  it('本地：仍是参数数组直 exec（引号内空格保留为单参数，不经 shell）', () => {
    const spec = buildExecSpec(coreOf({ command: 'echo "a b"' }));
    expect(spec.command).toBe('echo');
    expect(spec.args).toEqual(['a b']);
  });
});
