/**
 * 环境自检服务：只表达"检查环境"这个意图，不直接碰外部世界——
 * 命令走 executor、文件走 fs 适配器、配置走 config（AGENTS.md §4）。
 */
import { readJsonFileSync } from '../adapters/fs';
import { getDb } from '../adapters/db';
import { defaultProjectConfigPath, getConfig, loadConfig, type SkyportConfig } from '../config/config';
import { ERROR_CODES, isSkyportError } from '../errors/errors';
import { execute } from '../executor/executor';
import { defaultPolicyPath, loadPolicy } from './risk';
import { ZOMBIE_THRESHOLD_MINUTES } from './reconciliation';
import { getSecret } from './vault';

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
  checks.push(checkDatabase());
  checks.push(checkPolicy());
  checks.push(checkZombies());
  checks.push(checkVaultIntegrity());
  return { ok: checks.every((check) => check.ok), checks };
}

/** 保险箱完整性：试解第一条 secret（密文与主密钥不匹配时预警——vault.key 重生成会致旧密文报废） */
function checkVaultIntegrity(): DoctorCheck {
  try {
    const row = getDb().prepare('SELECT name FROM secrets LIMIT 1').get() as { name: string } | undefined;
    if (row === undefined) return { name: 'vault', ok: true, detail: '保险箱为空（无 secret）' };
    getSecret(row.name);
    return { name: 'vault', ok: true, detail: `保险箱解密正常（抽查 ${row.name}）` };
  } catch (error) {
    return { name: 'vault', ok: false, detail: `保险箱解密异常：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 僵尸可见性（v0.3.x 僵尸对账）：doctor 只诊断不修复，发现即提示跑 reconcile */
function checkZombies(): DoctorCheck {
  try {
    const cutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_MINUTES * 60_000).toISOString();
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'executing' AND updated_at < ?")
      .get(cutoff) as { n: number };
    const hint = row.n > 0 ? `，⚠ ${row.n} 条超时执行中行动待对账（skyport reconcile / serve 每 5 分钟自动对账）` : '';
    return {
      name: 'zombie-actions',
      ok: true,
      detail: `执行中行动对账：超时阈值 ${ZOMBIE_THRESHOLD_MINUTES} 分钟${hint}`,
    };
  } catch (error) {
    return { name: 'zombie-actions', ok: false, detail: describe(error) };
  }
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

function checkDatabase(): DoctorCheck {
  try {
    const row = getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
      v: number | null;
    };
    return { name: 'database', ok: true, detail: `数据库就绪（schema v${row.v ?? 0}，WAL 模式）` };
  } catch (error) {
    return { name: 'database', ok: false, detail: describe(error) };
  }
}

/** 安全姿态可见性（红队 S2）：策略位置、autoExecLowRisk 开启即警示 */
function checkPolicy(): DoctorCheck {
  try {
    const policy = loadPolicy();
    const path = getConfig().policyPath ?? defaultPolicyPath();
    const flag = policy.autoExecLowRisk ? '，⚠ autoExecLowRisk 已开启：低危命令免审批自动执行' : '';
    return {
      name: 'policy',
      ok: true,
      detail: `策略 ${path}（rules=${policy.rules.length}，whitelist=${policy.whitelist.length}${flag}）`,
    };
  } catch (error) {
    return { name: 'policy', ok: false, detail: describe(error) };
  }
}

function describe(error: unknown): string {
  if (isSkyportError(error)) return `${error.type}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
