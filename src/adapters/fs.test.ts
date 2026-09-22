import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSkyportError } from '../errors/errors';
import { appendLineSync, readJsonFileSync, readFileUtf8, writeFileUtf8, writeFileUtf8Sync } from './fs';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-fs-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function captureFsError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isSkyportError(error)) return error.type;
    throw error;
  }
  throw new Error('期望 fs 适配器抛错，但它正常返回了');
}

async function captureFsErrorAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isSkyportError(error)) return error.type;
    throw error;
  }
  throw new Error('期望 fs 适配器抛错，但它正常返回了');
}

describe('fs 文件适配器', () => {
  it('正常路径：UTF-8 写入后读回原文（含中文）', async () => {
    const path = join(tempDir, 'note.txt');
    await writeFileUtf8(path, '你好 skyport');
    expect(await readFileUtf8(path)).toBe('你好 skyport');
  });

  it('正常路径：readJsonFileSync 解析 JSON 对象', () => {
    const path = join(tempDir, 'data.json');
    writeFileUtf8Sync(path, JSON.stringify({ a: 1 }));
    expect(readJsonFileSync(path)).toEqual({ a: 1 });
  });

  it('正常路径：appendLineSync 逐行追加（logger 落盘依赖），文件自动创建', async () => {
    const path = join(tempDir, 'app.log');
    appendLineSync(path, '第一行');
    appendLineSync(path, '第二行');
    expect(await readFileUtf8(path)).toBe('第一行\n第二行\n');
  });

  it('失败路径-文件不存在：异步读归一化为 FS_NOT_FOUND', async () => {
    const missing = join(tempDir, 'missing.txt');
    const type = await captureFsErrorAsync(() => readFileUtf8(missing));
    expect(type).toBe('SKYPORT_FS_NOT_FOUND');
  });

  it('失败路径-文件不存在：同步读 JSON 归一化为 FS_NOT_FOUND', () => {
    const missing = join(tempDir, 'missing.json');
    const type = captureFsError(() => readJsonFileSync(missing));
    expect(type).toBe('SKYPORT_FS_NOT_FOUND');
  });

  it('失败路径-JSON 语法错误：归一化为 FS_READ_FAILED（与 IO 错误区分）', () => {
    const path = join(tempDir, 'broken.json');
    writeFileUtf8Sync(path, '{oops');
    const type = captureFsError(() => readJsonFileSync(path));
    expect(type).toBe('SKYPORT_FS_READ_FAILED');
  });
});
