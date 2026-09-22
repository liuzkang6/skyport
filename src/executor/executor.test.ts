import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSkyportError } from '../errors/errors';
import { execute } from './executor';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-exec-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

interface CapturedExecError {
  type: string;
  retryable: boolean;
  context: Record<string, unknown>;
}

async function captureExecError(fn: () => Promise<unknown>): Promise<CapturedExecError> {
  try {
    await fn();
  } catch (error) {
    if (isSkyportError(error)) {
      return { type: error.type, retryable: error.retryable, context: { ...error.context } };
    }
    throw error;
  }
  throw new Error('期望命令执行失败，但它成功返回了');
}

describe('executor 命令执行层', () => {
  it('正常路径：返回结构化结果（含尝试次数与截断标志）', async () => {
    const result = await execute('node', ['-e', "process.stdout.write('ok')"]);
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.attempts).toBe(1);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  it('失败路径-非零退出码：归一化为 EXEC_NON_ZERO，context 带退出码与尝试次数，且不重试', async () => {
    const captured = await captureExecError(() =>
      execute('node', ['-e', 'process.exit(7)'], { maxRetries: 3, backoffBaseMs: 1 }),
    );
    expect(captured.type).toBe('SKYPORT_EXEC_NON_ZERO');
    expect(captured.retryable).toBe(false);
    expect(captured.context.exitCode).toBe(7);
    expect(captured.context.attempts).toBe(1);
  });

  it('失败路径-命令不存在：归一化为 EXEC_NOT_FOUND，且立即失败不重试', async () => {
    const captured = await captureExecError(() =>
      execute('skyport-no-such-command', [], { maxRetries: 2, backoffBaseMs: 1 }),
    );
    expect(captured.type).toBe('SKYPORT_EXEC_NOT_FOUND');
    expect(captured.retryable).toBe(false);
  });

  it('失败路径-超时（红队 S9）：默认不重试，attempts=1，context 带真实耗时', async () => {
    const startedAt = Date.now();
    const captured = await captureExecError(() =>
      execute('node', ['-e', 'setInterval(() => {}, 50)'], { timeoutMs: 150, maxRetries: 3 }),
    );
    expect(captured.type).toBe('SKYPORT_EXEC_TIMEOUT');
    expect(captured.retryable).toBe(false);
    expect(captured.context.attempts).toBe(1);
    expect(captured.context.durationMs).toBeGreaterThanOrEqual(100);
    // 不重试意味着总耗时应接近单次超时，而非 4 次叠加
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('失败路径-输出超限：stdout 按字节截断并带截断标志（红队 S12）', async () => {
    const result = await execute('node', ['-e', "process.stdout.write('a'.repeat(4096))"], {
      maxOutputBytes: 16,
    });
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(16);
    expect(result.stdoutTruncated).toBe(true);
  });

  it('重试恢复（显式 retryOnTimeout）：第一次超时被杀，第二次成功，attempts=2', async () => {
    const marker = join(tempDir, 'marker');
    const script = `const fs=require('fs');const m=${JSON.stringify(marker)};if(fs.existsSync(m)){process.stdout.write('recovered');}else{fs.writeFileSync(m,'1');setInterval(()=>{},50);}`;
    const result = await execute('node', ['-e', script], {
      timeoutMs: 400,
      maxRetries: 1,
      backoffBaseMs: 10,
      retryOnTimeout: true,
    });
    expect(result.stdout).toBe('recovered');
    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(2);
  });
});
