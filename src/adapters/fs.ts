/**
 * 文件 I/O 适配器 —— 全项目唯一的文件读写入口（AGENTS.md §4）。
 * 业务代码禁止直接调 node:fs；需要文件能力时从本模块导入。
 * 所有底层异常统一归一化为 SKYPORT_FS_* / SKYPORT_PERMISSION_* 错误码再上抛。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createError, ERROR_CODES, type SkyportError } from '../errors/errors';

type FsAction = 'read' | 'write';

/** 把 node:fs 的原始异常归一化为带稳定码的 SkyportError */
function normalizeFsError(path: string, action: FsAction, error: unknown): SkyportError {
  const code = getErrnoCode(error);
  if (code === 'ENOENT') {
    return createError(ERROR_CODES.FS_NOT_FOUND, `文件不存在: ${path}`, {
      cause: error,
      context: { path, code },
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return createError(ERROR_CODES.PERMISSION_DENIED, `无权限访问文件: ${path}`, {
      cause: error,
      context: { path, code },
    });
  }
  const type = action === 'read' ? ERROR_CODES.FS_READ_FAILED : ERROR_CODES.FS_WRITE_FAILED;
  const verb = action === 'read' ? '读取' : '写入';
  return createError(type, `文件${verb}失败: ${path}`, { cause: error, context: { path, code } });
}

function getErrnoCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

export async function readFileUtf8(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw normalizeFsError(path, 'read', error);
  }
}

export async function writeFileUtf8(path: string, data: string): Promise<void> {
  try {
    await writeFile(path, data, 'utf8');
  } catch (error) {
    throw normalizeFsError(path, 'write', error);
  }
}

/** 同步读 JSON（配置加载在进程启动期需要同步语义） */
export function readJsonFileSync(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw normalizeFsError(path, 'read', error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // JSON 语法错误与 IO 错误分开：读取本身成功了，是内容不合法
    throw createError(ERROR_CODES.FS_READ_FAILED, `JSON 解析失败: ${path}`, {
      cause: error,
      context: { path },
    });
  }
}

/** 同步逐行追加（logger 落盘 sink 依赖；文件不存在会自动创建） */
export function appendLineSync(path: string, line: string): void {
  try {
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch (error) {
    throw normalizeFsError(path, 'write', error);
  }
}

/** 同步写文件（测试与简单场景用） */
export function writeFileUtf8Sync(path: string, data: string): void {
  try {
    writeFileSync(path, data, 'utf8');
  } catch (error) {
    throw normalizeFsError(path, 'write', error);
  }
}

/** 幂等建目录（backup/部署类服务用；mode 只在新建时生效） */
export function ensureDir(path: string, mode?: number): void {
  try {
    const options: { recursive: true; mode?: number } = { recursive: true };
    if (mode !== undefined) options.mode = mode;
    mkdirSync(path, options);
  } catch (error) {
    throw normalizeFsError(path, 'write', error);
  }
}

/** 显式收紧权限（调用方决定是否收紧——默认数据目录才收紧，见 S5 规矩） */
export function setFileMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    throw normalizeFsError(path, 'write', error);
  }
}

export function fileExistsSync(path: string): boolean {
  return existsSync(path);
}

export function readBinarySync(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw normalizeFsError(path, 'read', error);
  }
}

export function writeBinarySync(path: string, data: Buffer): void {
  try {
    writeFileSync(path, data);
  } catch (error) {
    throw normalizeFsError(path, 'write', error);
  }
}

export function readFileUtf8Sync(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw normalizeFsError(path, 'read', error);
  }
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    throw normalizeFsError(path, 'read', error);
  }
}

export function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    throw normalizeFsError(path, 'read', error);
  }
}

export function removePath(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    throw normalizeFsError(path, 'write', error);
  }
}

export function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    throw normalizeFsError(path, 'read', error);
  }
}
