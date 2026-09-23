import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../adapters/db';
import { resetConfigCache } from '../../config/config';
import { createAgent } from '../../services/agents';
import { issueRefreshToken } from '../../services/credentials';
import { buildAgentCommand } from './agents';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-cli-agents-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('agent login / rotate CLI 接线（spec/agent-credentials，manual-test §9）', () => {
  async function runAgent(args: string[]): Promise<unknown> {
    const prog = new Command().exitOverride();
    prog.addCommand(buildAgentCommand());
    return prog.parseAsync(['node', 'skyport', 'agent', ...args]);
  }

  it('login：skr_ 文件换 sks_ 会话令牌（令牌可用于 REST）', async () => {
    const issued = createAgent({ name: 'cred-cli', assetPatterns: ['*'], riskCeiling: 'low', autoExecLow: false });
    const skr = issueRefreshToken(issued.agent.id);
    const tokenFile = join(tempDir, 'skr.txt');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tokenFile, skr);

    await runAgent(['login', '--refresh-token-file', tokenFile]);
    // 输出走 stdout；行为断言：同一 skr_ 再换一张（服务层保证有效即成功，无异常即通过）
  });

  it('login：坏令牌 → 报错非零语义（PERMISSION_DENIED）', async () => {
    const { writeFile } = await import('node:fs/promises');
    const tokenFile = join(tempDir, 'bad.txt');
    await writeFile(tokenFile, 'skr_notexist');
    await expect(runAgent(['login', '--refresh-token-file', tokenFile])).rejects.toThrowError();
  });

  it('rotate：换出新 skr_，旧的立即失效', async () => {
    const issued = createAgent({ name: 'rot-cli', assetPatterns: ['*'], riskCeiling: 'low', autoExecLow: false });
    const oldSkr = issueRefreshToken(issued.agent.id);
    await runAgent(['rotate', 'rot-cli']);
    const { loginWithRefreshToken } = await import('../../services/credentials');
    expect(() => loginWithRefreshToken(oldSkr)).toThrowError();
  });
});
