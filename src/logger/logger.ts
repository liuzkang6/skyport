/**
 * 日志体系：分级 debug/info/warn/error + traceId 贯穿（AGENTS.md 文件地图）。
 * 关键决定：
 * - 控制台输出走 stderr（stdout 留给 CLI 正常输出，保证可管道组合）
 * - debug 只进控制台 sink，永不进落盘 sink（info 及以上才落盘）
 * - traceId 在 CLI 顶层生成，经 rootLogger.configure 注入，之后所有条目自动携带
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogDetail {
  readonly [key: string]: unknown;
}

export interface LogEntry {
  readonly time: string;
  readonly level: LogLevel;
  readonly traceId: string;
  readonly message: string;
  readonly detail?: LogDetail | undefined;
}

export type LogSink = (entry: LogEntry) => void;

/** 统一单行格式：[时间] 级别 [traceId] 消息 {明细JSON} */
export function formatLogEntry(entry: LogEntry): string {
  const base = `[${entry.time}] ${entry.level.toUpperCase()} [${entry.traceId}] ${entry.message}`;
  return entry.detail === undefined ? base : `${base} ${JSON.stringify(entry.detail)}`;
}

const stderrSink: LogSink = (entry) => {
  process.stderr.write(`${formatLogEntry(entry)}\n`);
};

export interface LoggerOptions {
  readonly level?: LogLevel | undefined;
  readonly traceId?: string | undefined;
  /** 落盘 sink；debug 级条目永远不会被送进来 */
  readonly fileSink?: LogSink | undefined;
  /** 控制台 sink，缺省写 stderr */
  readonly consoleSink?: LogSink | undefined;
}

export class Logger {
  private level: LogLevel;
  private traceId: string;
  private fileSink: LogSink | undefined;
  private readonly consoleSink: LogSink;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.traceId = options.traceId ?? 'no-trace';
    this.fileSink = options.fileSink;
    this.consoleSink = options.consoleSink ?? stderrSink;
  }

  debug(message: string, detail?: LogDetail): void {
    this.write('debug', message, detail);
  }

  info(message: string, detail?: LogDetail): void {
    this.write('info', message, detail);
  }

  warn(message: string, detail?: LogDetail): void {
    this.write('warn', message, detail);
  }

  error(message: string, detail?: LogDetail): void {
    this.write('error', message, detail);
  }

  /** 顶层（CLI 入口）注入配置与 traceId；只覆盖显式提供的项 */
  configure(options: LoggerOptions): void {
    if (options.level !== undefined) this.level = options.level;
    if (options.traceId !== undefined) this.traceId = options.traceId;
    if (options.fileSink !== undefined) this.fileSink = options.fileSink;
  }

  /** 派生带新 traceId 的子 logger，共享 sinks，原 logger 不受影响 */
  withTraceId(traceId: string): Logger {
    return new Logger({
      level: this.level,
      traceId,
      fileSink: this.fileSink,
      consoleSink: this.consoleSink,
    });
  }

  get currentLevel(): LogLevel {
    return this.level;
  }

  private write(level: LogLevel, message: string, detail: LogDetail | undefined): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const entry: LogEntry =
      detail === undefined
        ? { time: new Date().toISOString(), level, traceId: this.traceId, message }
        : { time: new Date().toISOString(), level, traceId: this.traceId, message, detail };
    this.consoleSink(entry);
    // 规矩：debug 不落盘，只允许出现在控制台
    if (level !== 'debug' && this.fileSink !== undefined) this.fileSink(entry);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}

/** 进程级共享 logger：CLI 顶层 configure，executor/services 默认用它 */
export const rootLogger: Logger = createLogger();
