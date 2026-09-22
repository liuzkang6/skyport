/**
 * 环境自检服务：只表达"检查环境"这个意图，不直接碰外部世界——
 * 命令走 executor、文件走 fs 适配器、配置走 config（AGENTS.md §4）。
 */
import { readJsonFileSync } from '../adapters/fs';
import { defaultProjectConfigPath, loadConfig, type SkyportConfig } from '../config/config';
import { ERROR_CODES, isSkyportError } from '../errors/errors';
import { execute } from '../executor/executor';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(await checkNodeRuntime());
  checks.push(checkConfig());
  checks.push(checkProjectConfigFile());
  return { ok: checks.every((check) => check.ok), checks };
}

async function checkNodeRuntime(): Promise<DoctorCheck> {
  try {
    const result = await execute('node', ['--version']);
    return {
      name: 'node-runtime',
      ok: true,
      detail: `node ${result.stdout.trim()} 经 executor 执行成功（${result.durationMs}ms）`,
    };
  } catch (error) {
    return { name: 'node-runtime', ok: false, detail: describe(error) };
  }
}

function checkConfig(): DoctorCheck {
  try {
    const config: SkyportConfig = loadConfig();
    return {
      name: 'config',
      ok: true,
      detail: `配置加载成功：logLevel=${config.logLevel} execTimeoutMs=${config.execTimeoutMs} execMaxRetries=${config.execMaxRetries} execMaxOutputBytes=${config.execMaxOutputBytes}`,
    };
  } catch (error) {
    return { name: 'config', ok: false, detail: describe(error) };
  }
}

function checkProjectConfigFile(): DoctorCheck {
  const path = defaultProjectConfigPath();
  try {
    readJsonFileSync(path);
    return { name: 'project-config-file', ok: true, detail: `已加载项目配置 ${path}` };
  } catch (error) {
    // 项目配置是可选的：不存在不算失败
    if (isSkyportError(error) && error.type === ERROR_CODES.FS_NOT_FOUND) {
      return { name: 'project-config-file', ok: true, detail: `未创建（可选）：${path}` };
    }
    return { name: 'project-config-file', ok: false, detail: describe(error) };
  }
}

function describe(error: unknown): string {
  if (isSkyportError(error)) return `${error.type}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
