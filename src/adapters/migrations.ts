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
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          key_hash TEXT NOT NULL UNIQUE,
          key_hint TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          scopes TEXT NOT NULL DEFAULT '["action:create"]',
          asset_patterns TEXT NOT NULL DEFAULT '["*"]',
          risk_ceiling TEXT NOT NULL DEFAULT 'medium',
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE actions (
          id TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          target_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
          target_name TEXT NOT NULL DEFAULT 'local',
          target_kind TEXT NOT NULL DEFAULT 'local',
          reason TEXT,
          risk_level TEXT NOT NULL,
          risk_source TEXT NOT NULL,
          status TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_actions_status ON actions(status);
        CREATE TABLE action_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
          event TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          detail TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_action_events_action ON action_events(action_id);
        CREATE TABLE executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
          ok INTEGER NOT NULL,
          stdout TEXT NOT NULL,
          stderr TEXT NOT NULL,
          exit_code INTEGER,
          timed_out INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_executions_action ON executions(action_id);
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      // 红队 S9/S12：执行审计补真实语义
      db.exec(`
        ALTER TABLE executions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE executions ADD COLUMN stdout_truncated INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE executions ADD COLUMN stderr_truncated INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      // 审计链（红队 F2 + spec/audit-chain）：事件枚举约束在代码层，哈希链 + 全局序号在存储层
      db.exec(`
        ALTER TABLE action_events ADD COLUMN prev_hash TEXT;
        ALTER TABLE action_events ADD COLUMN hash TEXT;
        ALTER TABLE action_events ADD COLUMN seq INTEGER;
        CREATE INDEX IF NOT EXISTS idx_action_events_seq ON action_events(seq);
        ALTER TABLE executions ADD COLUMN prev_hash TEXT;
        ALTER TABLE executions ADD COLUMN hash TEXT;
        ALTER TABLE executions ADD COLUMN seq INTEGER;
        CREATE INDEX IF NOT EXISTS idx_executions_seq ON executions(seq);
      `);
    },
  },
];
