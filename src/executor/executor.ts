/**
 * 命令执行层 —— 全项目唯一的命令出口（AGENTS.md §4）。
 * 关键决定：
 * - 一律 child_process.spawn 参数数组形式（shell: false），绝不拼接 shell 字符串，防注入
 * - 超时默认 10s、失败后退避重试最多 3 次、单路输出截断默认 100KB；均可被 options 覆盖，默认值来自 config
 * - 红队 S9：超时默认【不】重试（非幂等命令重复执行有副作用），显式 retryOnTimeout 才退避
 * - 红队 S9/S12：结果与错误 context 如实携带总耗时 durationMs、尝试次数 attempts、截断标志
 * - 子进程异常/退出码统一归一化为 SKYPORT_EXEC_* / SKYPORT_PERMISSION_* 错误码后上抛
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { baseEnvironment, getConfig } from '../config/config';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { rootLogger } from '../logger/logger';

export interface ExecOptions {
  /** 单次尝试超时（毫秒），缺省取配置 execTimeoutMs（默认 10000） */
  readonly timeoutMs?: number | undefined;
  /** 失败后最多重试次数，缺省取配置 execMaxRetries（默认 3）；只有可重试错误才会重试 */
  readonly maxRetries?: number | undefined;
  /** 单路输出（stdout / stderr 各自独立）截断上限（字节），缺省取配置 execMaxOutputBytes（默认 102400） */
  readonly maxOutputBytes?: number | undefined;
  /** 退避基数（毫秒）：实际延迟 = 基数 × 2^(第几次重试-1)，缺省取配置 execBackoffBaseMs（默认 200） */
  readonly backoffBaseMs?: number | undefined;
  /** 超时后是否重试（红队 S9）：默认 false；确知命令幂等时显式开启 */
  readonly retryOnTimeout?: boolean | undefined;
  /** 子进程工作目录 */
  readonly cwd?: string | undefined;
  /** 在 process.env 基础上合并追加的环境变量（env 读取统一走 config.baseEnvironment，AGENTS §4） */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** 整个 execute() 调用的真实总耗时（含重试与退避）——审计不再记 0 */
  readonly durationMs: number;
  readonly attempts: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

interface RunOnceResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

interface RunOnceOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>> | undefined;
}

export async function execute(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const config = getConfig();
  const timeoutMs = options.timeoutMs ?? config.execTimeoutMs;
  const maxRetries = options.maxRetries ?? config.execMaxRetries;
  const maxOutputBytes = options.maxOutputBytes ?? config.execMaxOutputBytes;
  const backoffBaseMs = options.backoffBaseMs ?? config.execBackoffBaseMs;

  const overallStart = performance.now();
  const totalMs = (): number => Math.round(performance.now() - overallStart);
  const maxAttempts = maxRetries + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const once = await runOnce(command, args, {
        timeoutMs,
        maxOutputBytes,
        cwd: options.cwd,
        env: options.env,
      });
      return { ...once, durationMs: totalMs(), attempts: attempt };
    } catch (error) {
      lastError = error;
      // 红队 S9：超时默认不重试（sleep 60 不该被放大成 4 次执行）；显式 retryOnTimeout 视为可重试
      const isTimeout = isSkyportError(error) && error.type === ERROR_CODES.EXEC_TIMEOUT;
      const retryable =
        isSkyportError(error) && (error.retryable || (isTimeout && options.retryOnTimeout === true));
      if (!retryable || attempt === maxAttempts) {
        throw enrichErrorContext(error, attempt, totalMs());
      }
      const delayMs = backoffBaseMs * 2 ** (attempt - 1);
      rootLogger.warn('命令执行失败，退避后重试', {
        command,
        attempt,
        maxAttempts,
        delayMs,
        type: error.type,
      });
      await sleep(delayMs);
    }
  }
  throw enrichErrorContext(lastError, maxAttempts, totalMs());
}

/** 给归一化错误补上真实总耗时与尝试次数（审计与用户提示用） */
function enrichErrorContext(error: unknown, attempts: number, durationMs: number): unknown {
  if (!isSkyportError(error)) return error;
  if (error.context.attempts !== undefined && error.context.durationMs !== undefined) return error;
  const message = attempts > 1 ? `${error.message}（共尝试 ${attempts} 次）` : error.message;
  return createError(error.type, message, {
    cause: error.cause,
    context: { ...error.context, attempts, durationMs },
    retryable: error.retryable,
  });
}

async function runOnce(command: string, args: readonly string[], options: RunOnceOptions): Promise<RunOnceResult> {
  const startedAt = performance.now();
  return new Promise<RunOnceResult>((resolve, reject) => {
    const spawnOptions: SpawnOptions = { shell: false, stdio: ['ignore', 'pipe', 'pipe'] };
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
    if (options.env !== undefined) spawnOptions.env = { ...baseEnvironment(), ...options.env };
    const child = spawn(command, args, spawnOptions);

    const stdoutCollector = createOutputCollector(options.maxOutputBytes);
    const stderrCollector = createOutputCollector(options.maxOutputBytes);
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL 确保超时后子进程必死，避免僵尸进程占住 Promise
      child.kill('SIGKILL');
    }, options.timeoutMs);

    // error 与 close 可能接连触发，只结算一次
    const settle = (settleFn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleFn();
    };

    if (child.stdout !== null) child.stdout.on('data', (chunk: Buffer) => stdoutCollector.push(chunk));
    if (child.stderr !== null) child.stderr.on('data', (chunk: Buffer) => stderrCollector.push(chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(() => reject(normalizeSpawnError(command, error)));
    });

    child.on('close', (code, signal) => {
      const durationMs = Math.round(performance.now() - startedAt);
      if (stdoutCollector.wasTruncated() || stderrCollector.wasTruncated()) {
        rootLogger.warn('命令输出超限，已按字节截断', { command, maxOutputBytes: options.maxOutputBytes });
      }
      settle(() => {
        if (timedOut) {
          reject(
            createError(ERROR_CODES.EXEC_TIMEOUT, `命令执行超时（${options.timeoutMs}ms）: ${command}`, {
              context: {
                command,
                args,
                timeoutMs: options.timeoutMs,
                durationMs,
                stdoutTruncated: stdoutCollector.wasTruncated(),
                stderrTruncated: stderrCollector.wasTruncated(),
              },
            }),
          );
          return;
        }
        if (code === 0) {
          resolve({
            stdout: stdoutCollector.text(),
            stderr: stderrCollector.text(),
            exitCode: 0,
            durationMs,
            stdoutTruncated: stdoutCollector.wasTruncated(),
            stderrTruncated: stderrCollector.wasTruncated(),
          });
          return;
        }
        // 退出码归一化：非 0 一律 EXEC_NON_ZERO（含被信号杀死），退出码放进 context 供上层判断
        reject(
          createError(ERROR_CODES.EXEC_NON_ZERO, `命令以非零退出码结束（${code ?? `signal ${signal ?? 'unknown'}`}）: ${command}`, {
            context: {
              command,
              args,
              exitCode: code,
              signal: signal ?? undefined,
              stderr: stderrCollector.text(),
              durationMs,
              stdoutTruncated: stdoutCollector.wasTruncated(),
              stderrTruncated: stderrCollector.wasTruncated(),
            },
          }),
        );
      });
    });
  });
}

function normalizeSpawnError(command: string, error: NodeJS.ErrnoException): Error {
  if (error.code === 'ENOENT') {
    return createError(ERROR_CODES.EXEC_NOT_FOUND, `命令不存在: ${command}`, {
      cause: error,
      context: { command, code: error.code },
    });
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return createError(ERROR_CODES.PERMISSION_DENIED, `无权限执行命令: ${command}`, {
      cause: error,
      context: { command, code: error.code },
    });
  }
  return createError(ERROR_CODES.EXEC_SPAWN_FAILED, `命令无法启动: ${command}`, {
    cause: error,
    context: { command, code: error.code },
  });
}

/** 按字节上限收集输出，超限截断并记录标志（截断只告警，不报错；标志落审计） */
function createOutputCollector(maxBytes: number): {
  push: (chunk: Buffer) => void;
  text: () => string;
  wasTruncated: () => boolean;
} {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      if (totalBytes >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - totalBytes;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        totalBytes = maxBytes;
        truncated = true;
      } else {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    wasTruncated() {
      return truncated;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
