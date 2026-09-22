import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSkyportError } from '../errors/errors';
import { loadConfig, PROJECT_CONFIG_FILENAME, resetConfigCache } from './config';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-config-'));
});

afterEach(() => {
  resetConfigCache();
});

function absentConfigPath(): string {
  return join(tempDir, PROJECT_CONFIG_FILENAME);
}

/** 收集 loadConfig 抛出的错误码，避免把失败写成通过 */
function captureConfigError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isSkyportError(error)) return error.type;
    throw error;
  }
  throw new Error('期望抛出配置错误，但 loadConfig 正常返回了');
}

describe('config 配置体系', () => {
  it('正常路径：无任何来源时取 schema 内置默认值（10s 超时 / 重试 3 次 / 截断 100KB）', () => {
    const config = loadConfig({ env: {}, configPath: absentConfigPath() });
    expect(config.logLevel).toBe('info');
    expect(config.execTimeoutMs).toBe(10_000);
    expect(config.execMaxRetries).toBe(3);
    expect(config.execMaxOutputBytes).toBe(100 * 1024);
    expect(config.execBackoffBaseMs).toBe(200);
  });

  it('正常路径：SKYPORT_ 环境变量覆盖默认值，字符串自动强转为数字', () => {
    const config = loadConfig({
      env: { SKYPORT_EXEC_TIMEOUT_MS: '2500', SKYPORT_LOG_LEVEL: 'debug' },
      configPath: absentConfigPath(),
    });
    expect(config.execTimeoutMs).toBe(2500);
    expect(config.logLevel).toBe('debug');
  });

  it('优先级：项目配置文件 > 环境变量 > 默认值', async () => {
    const path = join(tempDir, PROJECT_CONFIG_FILENAME);
    await writeFile(path, JSON.stringify({ execTimeoutMs: 5000, logLevel: 'warn' }), 'utf8');
    const config = loadConfig({
      env: { SKYPORT_EXEC_TIMEOUT_MS: '2500', SKYPORT_LOG_LEVEL: 'debug' },
      configPath: path,
    });
    expect(config.execTimeoutMs).toBe(5000);
    expect(config.logLevel).toBe('warn');
  });

  it('失败路径：环境变量值非法（枚举外的日志级别）→ CONFIG_INVALID', () => {
    const type = captureConfigError(() =>
      loadConfig({ env: { SKYPORT_LOG_LEVEL: 'loud' }, configPath: absentConfigPath() }),
    );
    expect(type).toBe('SKYPORT_CONFIG_INVALID');
  });

  it('失败路径：项目配置含未知键（拼错键名）→ CONFIG_INVALID（strict 防静默失效）', async () => {
    const path = join(tempDir, PROJECT_CONFIG_FILENAME);
    await writeFile(path, JSON.stringify({ timeout: 1 }), 'utf8');
    const type = captureConfigError(() => loadConfig({ env: {}, configPath: path }));
    expect(type).toBe('SKYPORT_CONFIG_INVALID');
  });

  it('失败路径：项目配置 JSON 语法错误 → CONFIG_LOAD_FAILED', async () => {
    const path = join(tempDir, PROJECT_CONFIG_FILENAME);
    await writeFile(path, '{oops', 'utf8');
    const type = captureConfigError(() => loadConfig({ env: {}, configPath: path }));
    expect(type).toBe('SKYPORT_CONFIG_LOAD_FAILED');
  });
});
