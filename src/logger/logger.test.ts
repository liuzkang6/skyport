import { describe, expect, it } from 'vitest';
import { createLogger, formatLogEntry, type LogEntry, type LogSink } from './logger';

function memorySink(): { entries: LogEntry[]; sink: LogSink } {
  const entries: LogEntry[] = [];
  return { entries, sink: (entry) => entries.push(entry) };
}

describe('logger 分级与 traceId', () => {
  it('正常路径：info/warn/error 同时进控制台与落盘 sink', () => {
    const consoleOut = memorySink();
    const fileOut = memorySink();
    const logger = createLogger({
      level: 'info',
      traceId: 'trace-1',
      consoleSink: consoleOut.sink,
      fileSink: fileOut.sink,
    });
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(consoleOut.entries.map((entry) => entry.level)).toEqual(['info', 'warn', 'error']);
    expect(fileOut.entries.map((entry) => entry.level)).toEqual(['info', 'warn', 'error']);
  });

  it('规矩验证：debug 只进控制台，永不落盘', () => {
    const consoleOut = memorySink();
    const fileOut = memorySink();
    const logger = createLogger({
      level: 'debug',
      consoleSink: consoleOut.sink,
      fileSink: fileOut.sink,
    });
    logger.debug('调试细节');
    expect(consoleOut.entries).toHaveLength(1);
    expect(fileOut.entries).toHaveLength(0);
  });

  it('失败路径语义：低于当前级别的日志被过滤', () => {
    const consoleOut = memorySink();
    const logger = createLogger({ level: 'warn', consoleSink: consoleOut.sink });
    logger.info('应被过滤');
    expect(consoleOut.entries).toHaveLength(0);
    logger.error('应被记录');
    expect(consoleOut.entries).toHaveLength(1);
  });

  it('traceId 贯穿：条目携带创建时注入的 traceId', () => {
    const consoleOut = memorySink();
    const logger = createLogger({ traceId: 'trace-42', consoleSink: consoleOut.sink });
    logger.info('hello');
    expect(consoleOut.entries[0]?.traceId).toBe('trace-42');
  });

  it('withTraceId 派生子 logger，不影响原 logger 的 traceId', () => {
    const consoleOut = memorySink();
    const logger = createLogger({ traceId: 'parent', consoleSink: consoleOut.sink });
    const child = logger.withTraceId('child');
    child.info('来自子任务');
    logger.info('来自父任务');
    expect(consoleOut.entries.map((entry) => entry.traceId)).toEqual(['child', 'parent']);
  });

  it('formatLogEntry 单行格式包含时间/级别/traceId/消息', () => {
    const line = formatLogEntry({
      time: '2026-09-22T00:00:00.000Z',
      level: 'info',
      traceId: 'trace-1',
      message: 'hello',
    });
    expect(line).toContain('2026-09-22T00:00:00.000Z');
    expect(line).toContain('INFO');
    expect(line).toContain('[trace-1]');
    expect(line).toContain('hello');
  });
});
