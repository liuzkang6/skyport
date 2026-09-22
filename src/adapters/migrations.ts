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
  {
    version: 5,
    up: (db) => {
      // 高危护栏（spec/guardrails）：回滚声明 + dry-run 支持
      db.exec('ALTER TABLE actions ADD COLUMN rollback TEXT;');
    },
  },
  {
    version: 6,
    up: (db) => {
      // CMDB-lite v2：服务目录 + 依赖拓扑边
      db.exec(`
        CREATE TABLE services (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          owner TEXT,
          labels TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE service_dependencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
          depends_on_service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          UNIQUE(service_id, depends_on_service_id)
        );
        CREATE TABLE asset_services (
          asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
          PRIMARY KEY (asset_id, service_id)
        );
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      // 保险箱（spec/vault）：AES-256-GCM 加密存储
      db.exec(`
        CREATE TABLE secrets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          encrypted_value TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          hint TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 8,
    up: (db) => {
      // 凭证三层（spec/agent-credentials）：刷新令牌 + 会话令牌
      db.exec(`
        ALTER TABLE agents ADD COLUMN refresh_token_hash TEXT;
        ALTER TABLE agents ADD COLUMN refresh_expires_at TEXT;
        CREATE TABLE agent_sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_agent_sessions_agent ON agent_sessions(agent_id);
      `);
    },
  },
  {
    version: 9,
    up: (db) => {
      // 告警总线（spec/alert-bus）：Alerta 模型
      db.exec(`
        CREATE TABLE alerts (
          id TEXT PRIMARY KEY,
          event TEXT NOT NULL,
          resource TEXT NOT NULL,
          severity TEXT NOT NULL CHECK(severity IN ('critical','warning','info')),
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','ack','closed')),
          value TEXT,
          text TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          attributes TEXT NOT NULL DEFAULT '{}',
          correlate TEXT NOT NULL DEFAULT '[]',
          origin TEXT NOT NULL DEFAULT 'api',
          asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
          timestamp TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          dedup_key TEXT NOT NULL UNIQUE,
          escalated INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_alerts_status ON alerts(status);
        CREATE INDEX idx_alerts_severity ON alerts(severity);
        CREATE TABLE alert_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
          field TEXT NOT NULL,
          old_value TEXT,
          new_value TEXT,
          changed_at TEXT NOT NULL
        );
        CREATE INDEX idx_alert_history_alert ON alert_history(alert_id);
      `);
    },
  },
];

