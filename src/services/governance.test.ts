import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { generateReport, createHandover, getLatestHandover } from './governance';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-gov-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('治理月报 + 交接班（v0.7）', () => {
  it('月报：空库也能生成，审计链完整', () => {
    const report = generateReport(24);
    expect(report.actions.total).toBe(0);
    expect(report.audit.chainIntact).toBe(true);
    expect(report.period.since).toBeTruthy();
  });

  it('交接班：生成即落库，getLatestHandover 读回最近一条', () => {
    expect(getLatestHandover()).toBeUndefined();

    const first = createHandover('第一班：平稳', 'human:alice');
    expect(first.notes).toBe('第一班：平稳');
    const second = createHandover('第二班：观察磁盘', 'human:bob');

    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM handovers').get() as { n: number };
    expect(rows.n).toBe(2);

    const latest = getLatestHandover();
    expect(latest?.createdBy).toBe('human:bob');
    expect(latest?.snapshot.notes).toBe('第二班：观察磁盘');
    expect(latest?.generatedAt).toBe(second.generatedAt);
  });

  it('交接班快照包含开放告警与待审批行动', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO alerts (id, event, resource, severity, status, origin, dedup_key, timestamp, created_at, updated_at)
      VALUES ('alt_h1', 'DiskFull', 't9', 'critical', 'open', 'test', 'dk1', ?, ?, ?)`).run(now, now, now);
    db.prepare(`INSERT INTO actions (id, command, target_name, target_kind, risk_level, risk_source, status, actor_type, actor_id, created_at, updated_at)
      VALUES ('act_h1', 'df -h', 'local', 'local', 'high', 'test', 'pending', 'human', 'u1', ?, ?)`).run(now, now);

    const snapshot = createHandover('带现场的班', 'human:carol');
    expect(snapshot.openAlerts.map((a) => a.event)).toContain('DiskFull');
    expect(snapshot.pendingActions.map((a) => a.id)).toContain('act_h1');
  });
});
