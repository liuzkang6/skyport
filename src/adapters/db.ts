/**
 * SQLite 数据库适配器 —— 全项目唯一的数据库连接入口（AGENTS.md §4）。
 * 关键决定：
 * - better-sqlite3 同步 API + WAL：契合 CLI 单次进程模型，读写免 async 化
 * - 安全基线：数据目录 0700、库文件 0600（单机信任模型的文件层加固，PRD §3）
 * - 打开即迁移（schema_version 顺序迁移，幂等），迁移失败整体回滚
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { getConfig } from '../config/config';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { MIGRATIONS } from './migrations';

let cachedDb: Database.Database | undefined;

/** 进程内共享连接；首次调用按配置打开并迁移，库不存在会自动创建 */
export function getDb(): Database.Database {
  if (cachedDb !== undefined) return cachedDb;
  cachedDb = openDatabase(getConfig().dbPath);
  return cachedDb;
}

/** 关闭并忘记当前连接（测试与显式重载用） */
export function closeDb(): void {
  if (cachedDb !== undefined) {
    cachedDb.close();
    cachedDb = undefined;
  }
}

export function openDatabase(dbPath: string): Database.Database {
  try {
    // 目录权限兜底：mkdir 的 mode 只在新建时生效，目录已存在时显式 chmod 一次
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(dbPath), 0o700);
    const database = new Database(dbPath);
    chmodSync(dbPath, 0o600);
    migrate(database, dbPath);
    return database;
  } catch (error) {
    if (isSkyportError(error)) throw error;
    throw createError(ERROR_CODES.DB_OPEN_FAILED, `数据库打开失败: ${dbPath}`, {
      cause: error,
      context: { dbPath },
    });
  }
}

function migrate(database: Database.Database, dbPath: string): void {
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    const runMigrations = database.transaction((): void => {
      database.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      const row = database.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number | null;
      };
      const current = row.v ?? 0;
      for (const migration of MIGRATIONS) {
        if (migration.version <= current) continue;
        migration.up(database);
        database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
      }
    });
    runMigrations();
  } catch (error) {
    if (isSkyportError(error)) throw error;
    throw createError(ERROR_CODES.DB_MIGRATION_FAILED, `数据库迁移失败: ${dbPath}`, {
      cause: error,
      context: { dbPath },
    });
  }
}
