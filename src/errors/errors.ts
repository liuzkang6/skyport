/**
 * 错误码清单（按域分组）+ 错误工厂（AGENTS.md §3）。
 * 规矩：新增错误类型时，先在这里登记错误码，再在业务代码中使用。
 * 判断错误一律用错误码（type），不依赖错误文本。
 */

/** 错误码按域分组：config / exec / fs / network / permission */
export const ERROR_CODES = {
  /** config 域：配置读取与校验 */
  CONFIG_INVALID: 'SKYPORT_CONFIG_INVALID',
  CONFIG_NOT_FOUND: 'SKYPORT_CONFIG_NOT_FOUND',
  CONFIG_LOAD_FAILED: 'SKYPORT_CONFIG_LOAD_FAILED',
  /** exec 域：命令执行 */
  EXEC_NOT_FOUND: 'SKYPORT_EXEC_NOT_FOUND',
  EXEC_TIMEOUT: 'SKYPORT_EXEC_TIMEOUT',
  EXEC_NON_ZERO: 'SKYPORT_EXEC_NON_ZERO',
  EXEC_SPAWN_FAILED: 'SKYPORT_EXEC_SPAWN_FAILED',
  /** fs 域：文件读写 */
  FS_NOT_FOUND: 'SKYPORT_FS_NOT_FOUND',
  FS_READ_FAILED: 'SKYPORT_FS_READ_FAILED',
  FS_WRITE_FAILED: 'SKYPORT_FS_WRITE_FAILED',
  /** network 域：网络请求 */
  NETWORK_REQUEST_FAILED: 'SKYPORT_NETWORK_REQUEST_FAILED',
  NETWORK_TIMEOUT: 'SKYPORT_NETWORK_TIMEOUT',
  /** permission 域：权限不足 */
  PERMISSION_DENIED: 'SKYPORT_PERMISSION_DENIED',
  /** permission 域：未认证（无凭证）。REST 映射 401；403 留给"认证了但无权"（红队 V9） */
  AUTH_REQUIRED: 'SKYPORT_AUTH_REQUIRED',
  /** db 域：数据库打开/迁移/读写 */
  DB_OPEN_FAILED: 'SKYPORT_DB_OPEN_FAILED',
  DB_MIGRATION_FAILED: 'SKYPORT_DB_MIGRATION_FAILED',
  DB_QUERY_FAILED: 'SKYPORT_DB_QUERY_FAILED',
  DB_BACKUP_FAILED: 'SKYPORT_DB_BACKUP_FAILED',
  /** asset 域：资产登记与查询 */
  ASSET_NOT_FOUND: 'SKYPORT_ASSET_NOT_FOUND',
  ASSET_DUPLICATE_NAME: 'SKYPORT_ASSET_DUPLICATE_NAME',
  ASSET_INVALID: 'SKYPORT_ASSET_INVALID',
  /** agent 域：AI 调用方身份管理 */
  AGENT_NOT_FOUND: 'SKYPORT_AGENT_NOT_FOUND',
  AGENT_DUPLICATE_NAME: 'SKYPORT_AGENT_DUPLICATE_NAME',
  AGENT_INVALID: 'SKYPORT_AGENT_INVALID',
  /** action 域：行动登记与状态机 */
  ACTION_NOT_FOUND: 'SKYPORT_ACTION_NOT_FOUND',
  ACTION_INVALID: 'SKYPORT_ACTION_INVALID',
  ACTION_INVALID_STATE: 'SKYPORT_ACTION_INVALID_STATE',
  /** user 域：Web 用户与登录（spec/webui） */
  USER_NOT_FOUND: 'SKYPORT_USER_NOT_FOUND',
  USER_DUPLICATE_NAME: 'SKYPORT_USER_DUPLICATE_NAME',
  USER_INVALID: 'SKYPORT_USER_INVALID',
  USER_LOCKED: 'SKYPORT_USER_LOCKED',
  USER_DISABLED: 'SKYPORT_USER_DISABLED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 结构化上下文：给人看、给日志看，禁止塞敏感明文（如密钥） */
export interface SkyportErrorContext {
  readonly [key: string]: unknown;
}

export interface SkyportErrorOptions {
  /** 原始原因（底层错误挂在这里向上冒泡） */
  readonly cause?: unknown;
  readonly context?: SkyportErrorContext;
  /** 是否可重试；缺省由错误码语义决定（见 RETRYABLE_CODES） */
  readonly retryable?: boolean;
}

export class SkyportError extends Error {
  /** 稳定码：调用方只认它 */
  readonly type: ErrorCode;
  readonly context: SkyportErrorContext;
  readonly retryable: boolean;

  constructor(type: ErrorCode, message: string, options: SkyportErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'SkyportError';
    this.type = type;
    this.context = options.context ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export function isSkyportError(error: unknown): error is SkyportError {
  return error instanceof SkyportError;
}

/** 按错误码语义默认可重试的错误（瞬时故障）；其余默认不可重试。
 * 红队 S9：EXEC_TIMEOUT 移出——超时默认不重试（非幂等命令重复执行有副作用） */
const RETRYABLE_CODES: ReadonlySet<string> = new Set<string>([ERROR_CODES.NETWORK_TIMEOUT]);

/** 错误工厂：统一补齐 retryable 缺省值，业务代码不要直接 new SkyportError */
export function createError(
  type: ErrorCode,
  message: string,
  options: SkyportErrorOptions = {},
): SkyportError {
  const retryable = options.retryable ?? RETRYABLE_CODES.has(type);
  return new SkyportError(type, message, { ...options, retryable });
}
