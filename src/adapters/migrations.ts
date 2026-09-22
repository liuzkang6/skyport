/**
 * 顺序迁移清单：每个版本一个 up()，只增不改——
 * 已发布的迁移不允许修改（改历史会破坏已部署库的幂等性），新变更加新版本号。
 */
import type Database from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly up: (db: Database.Database) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE assets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          addr TEXT,
          connect_mode TEXT,
          labels TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'unknown',
          last_check_at TEXT,
          last_check_latency_ms INTEGER,
          last_check_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_assets_type ON assets(type);
        CREATE TABLE asset_checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          ok INTEGER NOT NULL,
          latency_ms INTEGER,
          error TEXT,
          checked_at TEXT NOT NULL
        );
        CREATE INDEX idx_asset_checks_asset ON asset_checks(asset_id);
      `);
    },
  },
];
