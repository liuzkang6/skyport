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
  it('正常路径：返回结构化结果 { stdout, stderr, exitCode, durationMs }', async () => {
    const result = await execute('node', ['-e', "process.stdout.write('ok')"]);
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('失败路径-非零退出码：归一化为 EXEC_NON_ZERO，退出码在 context，且不触发重试', async () => {
    const captured = await captureExecError(() =>
      execute('node', ['-e', 'process.exit(7)'], { maxRetries: 3, backoffBaseMs: 1 }),
    );
    expect(captured.type).toBe('SKYPORT_EXEC_NON_ZERO');
    expect(captured.retryable).toBe(false);
    expect(captured.context.exitCode).toBe(7);
  });

  it('失败路径-命令不存在：归一化为 EXEC_NOT_FOUND，且立即失败不重试', async () => {
    const captured = await captureExecError(() =>
      execute('skyport-no-such-command', [], { maxRetries: 2, backoffBaseMs: 1 }),
    );
    expect(captured.type).toBe('SKYPORT_EXEC_NOT_FOUND');
    expect(captured.retryable).toBe(false);
  });

  it('失败路径-超时：归一化为 EXEC_TIMEOUT，标记可重试', async () => {
    const captured = await captureExecError(() =>
      execute('node', ['-e', 'setInterval(() => {}, 50)'], { timeoutMs: 150, maxRetries: 0 }),
    );
    expect(captured.type).toBe('SKYPORT_EXEC_TIMEOUT');
    expect(captured.retryable).toBe(true);
  });

  it('失败路径-输出超限：stdout 按字节上限截断', async () => {
    const result = await execute('node', ['-e', "process.stdout.write('a'.repeat(4096))"], {
      maxOutputBytes: 16,
    });
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(16);
  });

  it('重试恢复：第一次尝试超时被杀，退避后第二次成功', async () => {
    const marker = join(tempDir, 'marker');
    const script = `const fs=require('fs');const m=${JSON.stringify(marker)};if(fs.existsSync(m)){process.stdout.write('recovered');}else{fs.writeFileSync(m,'1');setInterval(()=>{},50);}`;
    const result = await execute('node', ['-e', script], {
      timeoutMs: 400,
      maxRetries: 1,
      backoffBaseMs: 10,
    });
    expect(result.stdout).toBe('recovered');
    expect(result.exitCode).toBe(0);
  });
});
