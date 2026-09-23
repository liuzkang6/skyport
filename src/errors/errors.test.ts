import { describe, expect, it } from 'vitest';
import { createError, ERROR_CODES, isSkyportError } from './errors';

describe('errors 错误工厂', () => {
  it('正常路径：EXEC_TIMEOUT 字段齐全；红队 S9 后默认不可重试（显式 retryOnTimeout 才重试）', () => {
    const error = createError(ERROR_CODES.EXEC_TIMEOUT, '命令执行超时');
    expect(error.type).toBe('SKYPORT_EXEC_TIMEOUT');
    expect(error.message).toBe('命令执行超时');
    expect(error.retryable).toBe(false);
    expect(error.context).toEqual({});
    expect(error.name).toBe('SkyportError');
  });

  it('正常路径：context 与 cause 原样保留', () => {
    const cause = new Error('root cause');
    const error = createError(ERROR_CODES.EXEC_NON_ZERO, '非零退出码', { cause, context: { exitCode: 7 } });
    expect(error.cause).toBe(cause);
    expect(error.context).toEqual({ exitCode: 7 });
  });

  it('失败路径语义：确定性错误（EXEC_NON_ZERO）默认不可重试', () => {
    const error = createError(ERROR_CODES.EXEC_NON_ZERO, 'x');
    expect(error.retryable).toBe(false);
  });

  it('显式 retryable 覆盖错误码默认值', () => {
    const error = createError(ERROR_CODES.EXEC_TIMEOUT, 'x', { retryable: false });
    expect(error.retryable).toBe(false);
  });

  it('isSkyportError 只识别 SkyportError，不误判普通错误', () => {
    expect(isSkyportError(new Error('普通错误'))).toBe(false);
    expect(isSkyportError(createError(ERROR_CODES.FS_NOT_FOUND, 'x'))).toBe(true);
  });

  it('全部错误码符合 SKYPORT_<域>_<名称> 约定（按域分组登记）', () => {
    const codes = Object.values(ERROR_CODES);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(code).toMatch(/^SKYPORT_(CONFIG|EXEC|FS|NETWORK|PERMISSION|DB|ASSET|AGENT|ACTION|USER|SESSION|AUTH)_[A-Z_]+$/);
    }
  });
});
