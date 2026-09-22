/**
 * 数据库备份（spec/backup/spec.md）：SQLite 在线备份 + 保留策略清理。
 * 权限边界与红队 S5 同规矩：默认目录（~/.skyport/backups）mkdir 0700、文件 0600；
 * 自定义目录只使用、绝不 chmod 使用者的目录。文件操作全部经 fs 适配器（arch 门禁）。
 */
import { getDb } from '../adapters/db';
import { ensureDir, fileMtimeMs, fileSize, listDir, removePath, setFileMode } from '../adapters/fs';
import { DATA_DIR } from '../config/config';
import { createError, ERROR_CODES } from '../errors/errors';

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly pruned: number;
}

export function defaultBackupDir(): string {
  return `${DATA_DIR}/backups`;
}

export async function backupDatabase(targetDir?: string, keep = 10): Promise<BackupResult> {
  const dir = targetDir ?? defaultBackupDir();
  const inDataDir = targetDir === undefined; // 权限收紧只作用于默认数据目录（S5 规矩）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = `${dir}/skyport-${stamp}.db`;
  try {
    ensureDir(dir, 0o700);
    if (inDataDir) setFileMode(dir, 0o700);
    await getDb().backup(dest); // SQLite 在线备份，WAL 安全，不锁主库
    if (inDataDir) setFileMode(dest, 0o600);
  } catch (error) {
    throw createError(ERROR_CODES.DB_BACKUP_FAILED, `数据库备份失败: ${dest}`, {
      cause: error,
      context: { dir, dest },
    });
  }
  const pruned = keep > 0 ? pruneBackups(dir, keep) : 0;
  return { path: dest, bytes: fileSize(dest), pruned };
}

/** 按修改时间新→旧保留 keep 份，超出删除；返回清理数量 */
function pruneBackups(dir: string, keep: number): number {
  const entries = listDir(dir)
    .filter((name) => name.startsWith('skyport-') && name.endsWith('.db'))
    .map((name) => ({ name, mtime: fileMtimeMs(`${dir}/${name}`) }))
    .sort((a, b) => b.mtime - a.mtime);
  const stale = entries.slice(keep);
  for (const entry of stale) {
    removePath(`${dir}/${entry.name}`);
  }
  return stale.length;
}
