/**
 * 配置体系 —— 环境变量与项目配置的唯一读取入口（AGENTS.md §4）。
 * 优先级：项目配置（skyport.config.json） > 环境变量（SKYPORT_ 前缀） > 默认值（schema 内置）。
 * 关键决定：默认值全部集中在下面 schema 里，业务代码禁止硬编码同类数值。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonFileSync } from '../adapters/fs';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { translateIssues } from '../errors/messages';
import { z } from 'zod';

/** 环境变量统一前缀（skyport_ 的大写形式） */
export const ENV_PREFIX = 'SKYPORT_';

/** 项目配置文件名（约定放在项目根目录） */
export const PROJECT_CONFIG_FILENAME = 'skyport.config.json';

/** 数据目录（信任模型：目录 0700、库文件 0600，由 db 适配器负责落实） */
export const DATA_DIR = join(homedir(), '.skyport');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevelName = (typeof LOG_LEVELS)[number];

/** strictObject：出现未知键直接报错，防止配置文件里拼错键名后静默失效 */
const configSchema = z.strictObject({
  logLevel: z.enum(LOG_LEVELS).default('info'),
  logFile: z.string().min(1).optional(),
  execTimeoutMs: z.coerce.number().int().positive().default(10_000),
  execMaxRetries: z.coerce.number().int().min(0).max(10).default(3),
  execMaxOutputBytes: z.coerce.number().int().positive().default(100 * 1024),
  execBackoffBaseMs: z.coerce.number().int().min(0).default(200),
  dbPath: z.string().min(1).default(join(DATA_DIR, 'skyport.db')),
  checkTimeoutMs: z.coerce.number().int().positive().default(5_000),
  /** agent 身份凭证（SKYPORT_API_KEY）：只在需要以 agent 身份调用时设置 */
  apiKey: z.string().min(1).optional(),
  /** pending 行动的出站 webhook（SKYPORT_NOTIFY_WEBHOOK_URL）；未配置则不发送 */
  notifyWebhookUrl: z.string().min(1).optional(),
  /** 风险策略文件显式路径（SKYPORT_POLICY_PATH）；缺省用 ~/.skyport/skyport.policy.json。
   * 红队 S2：策略一律不读 cwd——cwd 是被治理方（同 UID 的 AI）可写区 */
  policyPath: z.string().min(1).optional(),
  /** 错误输出显示底层技术细节（红队 S13：默认只给人话，排查时打开） */
  verboseErrors: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
  /** 备份保留份数（SKYPORT_BACKUP_KEEP）；skyport backup 按此清理旧备份 */
  backupKeep: z.coerce.number().int().min(0).max(1000).default(10),
});

export type SkyportConfig = z.infer<typeof configSchema>;

export interface LoadConfigOptions {
  /** 显式指定项目配置文件路径；缺省用当前工作目录下约定的 skyport.config.json */
  readonly configPath?: string | undefined;
  /** 覆盖环境变量来源（测试注入用）；缺省读取 process.env——本模块是 process.env 的唯一读取点 */
  readonly env?: Record<string, string | undefined> | undefined;
}

const ENV_KEY_TO_CONFIG_KEY: Readonly<Record<string, string>> = {
  SKYPORT_LOG_LEVEL: 'logLevel',
  SKYPORT_LOG_FILE: 'logFile',
  SKYPORT_EXEC_TIMEOUT_MS: 'execTimeoutMs',
  SKYPORT_EXEC_MAX_RETRIES: 'execMaxRetries',
  SKYPORT_EXEC_MAX_OUTPUT_BYTES: 'execMaxOutputBytes',
  SKYPORT_EXEC_BACKOFF_BASE_MS: 'execBackoffBaseMs',
  SKYPORT_DB_PATH: 'dbPath',
  SKYPORT_CHECK_TIMEOUT_MS: 'checkTimeoutMs',
  SKYPORT_API_KEY: 'apiKey',
  SKYPORT_NOTIFY_WEBHOOK_URL: 'notifyWebhookUrl',
  SKYPORT_POLICY_PATH: 'policyPath',
  SKYPORT_VERBOSE_ERRORS: 'verboseErrors',
  SKYPORT_BACKUP_KEEP: 'backupKeep',
};

export function defaultProjectConfigPath(): string {
  return join(process.cwd(), PROJECT_CONFIG_FILENAME);
}

export function loadConfig(options: LoadConfigOptions = {}): SkyportConfig {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? defaultProjectConfigPath();
  const fromFile = readProjectConfig(configPath);
  const fromEnv = pickEnvConfig(env);
  // 优先级落地：后展开者胜出 —— 默认值(schema) < 环境变量 < 项目配置
  const parsed = configSchema.safeParse({ ...fromEnv, ...fromFile });
  if (!parsed.success) {
    throw createError(ERROR_CODES.CONFIG_INVALID, '配置校验失败', {
      context: { path: configPath, issues: translateIssues(parsed.error.issues) },
    });
  }
  return parsed.data;
}

function pickEnvConfig(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [envKey, configKey] of Object.entries(ENV_KEY_TO_CONFIG_KEY)) {
    const value = env[envKey];
    // 空字符串视为未设置，避免 `SKYPORT_X=` 把配置置空导致校验失败
    if (value !== undefined && value !== '') result[configKey] = value;
  }
  return result;
}

function readProjectConfig(configPath: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = readJsonFileSync(configPath);
  } catch (error) {
    // 项目配置是可选来源：文件不存在视为"未提供"；其余读取失败才升级为配置错误
    if (isSkyportError(error) && error.type === ERROR_CODES.FS_NOT_FOUND) return {};
    throw createError(ERROR_CODES.CONFIG_LOAD_FAILED, `项目配置读取失败: ${configPath}`, {
      cause: error,
      context: { path: configPath },
    });
  }
  if (!isPlainObject(raw)) {
    throw createError(ERROR_CODES.CONFIG_INVALID, `项目配置必须是 JSON 对象: ${configPath}`, {
      context: { path: configPath },
    });
  }
  return raw;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let cachedConfig: SkyportConfig | undefined;

/** 进程内缓存：executor 等基础设施默认从这里取配置，避免每次执行重复读文件 */
export function getConfig(): SkyportConfig {
  if (cachedConfig === undefined) cachedConfig = loadConfig();
  return cachedConfig;
}

/** 重置缓存（测试注入 env 后需要重新加载时用） */
export function resetConfigCache(): void {
  cachedConfig = undefined;
}

/** 子进程环境基座：executor 组装子进程 env 的唯一来源。
 * 环境变量读取统一收敛在本模块（AGENTS §4），executor 不得直读 process.env。 */
export function baseEnvironment(): NodeJS.ProcessEnv {
  return process.env;
}
