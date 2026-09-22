/**
 * 命令执行层 —— 全项目唯一的命令出口（AGENTS.md §4）。
 * 关键决定：
 * - 一律 child_process.spawn 参数数组形式（shell: false），绝不拼接 shell 字符串，防注入
 * - 超时默认 10s、失败后退避重试最多 3 次、单路输出截断默认 100KB；均可被 options 覆盖，默认值来自 config
 * - 子进程异常/退出码统一归一化为 SKYPORT_EXEC_* / SKYPORT_PERMISSION_* 错误码后上抛
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { getConfig } from '../config/config';
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
  /** 子进程工作目录 */
  readonly cwd?: string | undefined;
  /** 在 process.env 基础上合并追加的环境变量（env 合并只发生在执行层这一处） */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
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

  const maxAttempts = maxRetries + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runOnce(command, args, { timeoutMs, maxOutputBytes, cwd: options.cwd, env: options.env });
    } catch (error) {
      lastError = error;
      // 只对"已归一化且标记可重试"的错误退避重试；未知错误原样上抛，由顶层处理
      if (!isSkyportError(error) || !error.retryable || attempt === maxAttempts) throw error;
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
  throw lastError; // 循环能走到这里必然已 throw，此行只为让类型收敛
}

async function runOnce(command: string, args: readonly string[], options: RunOnceOptions): Promise<ExecResult> {
  const startedAt = performance.now();
  return new Promise<ExecResult>((resolve, reject) => {
    const spawnOptions: SpawnOptions = { shell: false, stdio: ['ignore', 'pipe', 'pipe'] };
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
    if (options.env !== undefined) spawnOptions.env = { ...process.env, ...options.env };
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
          // 超时视为瞬时故障，错误工厂按码默认标记 retryable
          reject(
            createError(ERROR_CODES.EXEC_TIMEOUT, `命令执行超时（${options.timeoutMs}ms）: ${command}`, {
              context: { command, args, timeoutMs: options.timeoutMs, durationMs },
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
          });
          return;
        }
        // 退出码归一化：非 0 一律 EXEC_NON_ZERO（含被信号杀死），退出码放进 context 供上层判断
        reject(
          createError(ERROR_CODES.EXEC_NON_ZERO, `命令以非零退出码结束（${code ?? `signal ${signal ?? 'unknown'}`}）: ${command}`, {
            context: { command, args, exitCode: code, signal: signal ?? undefined, stderr: stderrCollector.text() },
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

/** 按字节上限收集输出，超限截断并记录标志（截断只告警，不报错） */
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
