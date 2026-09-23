import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { createRoleInstance } from './roles';
import { buildRuntimeConfig, toEnvScript, toMcpConfig } from './runtime-integration';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-rt-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('运行时集成层（v0.5）', () => {
  it('生成 MCP 配置：包含 skyport 服务器定义与认证', () => {
    const instance = createRoleInstance('investigator');
    const config = toMcpConfig({
      role: 'investigator',
      sessionToken: instance.sessionToken,
    });
    const mcp = (config as { mcpServers: { skyport: { command: string; env: Record<string, string> } } }).mcpServers.skyport;
    expect(mcp.command).toBe('node');
    expect(mcp.env.SKYPORT_API_KEY).toBe(instance.sessionToken);
    expect(mcp.env.SKYPORT_ROLE).toBe('investigator');
  });

  it('生成环境变量脚本（shell source 格式）', () => {
    const instance = createRoleInstance('patroller');
    const script = toEnvScript({ role: 'patroller', sessionToken: instance.sessionToken });
    expect(script).toContain(`SKYPORT_API_KEY="${instance.sessionToken}"`);
    expect(script).toContain('SKYPORT_ROLE="patroller"');
    expect(script).toContain('巡查员');
  });

  it('系统提示词包含角色职责', () => {
    const instance = createRoleInstance('reviewer');
    const config = buildRuntimeConfig({
      role: 'reviewer',
      sessionToken: instance.sessionToken,
    });
    expect(config.systemPrompt).toContain('审查员');
    expect(config.systemPrompt).toContain('注入探测器');
  });

  it('技能路径包含 skills 目录', () => {
    const instance = createRoleInstance('operator');
    const config = buildRuntimeConfig({
      role: 'operator',
      sessionToken: instance.sessionToken,
    });
    expect(config.skillsPath).toContain('skills');
  });

  it('失败路径-未知角色 → AGENT_INVALID', () => {
    try {
      buildRuntimeConfig({ role: 'ghost' as never, sessionToken: 'x' });
      throw new Error('应抛错');
    } catch (e) {
      expect(isSkyportError(e)).toBe(true);
    }
  });
});
