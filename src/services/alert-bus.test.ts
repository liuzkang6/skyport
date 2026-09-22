import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { addAsset } from './assets';
import {
  ackAlert,
  closeAlert,
  detectAndParse,
  getAlertById,
  getAlertStats,
  ingestAlert,
  listAlerts,
} from './alert-bus';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-alert-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

function cap(fn: () => unknown): string {
  try { fn(); } catch (e) { if (isSkyportError(e)) return e.type; throw e; }
  throw new Error('应抛错');
}

describe('告警总线（spec/alert-bus）', () => {
  it('Alertmanager 格式解析', () => {
    const body = {
      alerts: [{
        labels: { alertname: 'HighDiskUsage', instance: 'db-01', severity: 'critical' },
        annotations: { summary: 'Disk 91%' },
      }],
    };
    const parsed = detectAndParse(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.event).toBe('HighDiskUsage');
    expect(parsed[0]!.resource).toBe('db-01');
    expect(parsed[0]!.severity).toBe('critical');
    expect(parsed[0]!.origin).toBe('alertmanager');
  });

  it('Zabbix 格式解析', () => {
    const body = {
      eventid: '12345',
      host: { name: 'web-01' },
      trigger: { description: 'CPU high', priority: 4 },
    };
    const parsed = detectAndParse(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.resource).toBe('web-01');
    expect(parsed[0]!.severity).toBe('critical');
    expect(parsed[0]!.origin).toBe('zabbix');
  });

  it('skyport 原生格式解析', () => {
    const parsed = detectAndParse({ event: 'DiskFull', resource: 't1', severity: 'warning' });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.event).toBe('DiskFull');
  });

  it('无效格式 → 空数组', () => {
    expect(detectAndParse({ random: true })).toHaveLength(0);
  });

  it('正常路径：ingest → open 状态 → ack → close 全生命周期', () => {
    const parsed = detectAndParse({ event: 'TestAlert', resource: 't1', severity: 'warning' });
    const { alert, created } = ingestAlert(parsed[0]!);
    expect(created).toBe(true);
    expect(alert.status).toBe('open');

    const acked = ackAlert(alert.id);
    expect(acked.status).toBe('ack');

    const closed = closeAlert(alert.id);
    expect(closed.status).toBe('closed');
  });

  it('去重：同 resource+event+origin 重复 ingest 不新建，更新 severity 并记历史', () => {
    const p1 = detectAndParse({ event: 'Dup', resource: 'r1', severity: 'warning' });
    const r1 = ingestAlert(p1[0]!);
    expect(r1.created).toBe(true);

    const p2 = detectAndParse({ event: 'Dup', resource: 'r1', severity: 'critical' });
    const r2 = ingestAlert(p2[0]!);
    expect(r2.created).toBe(false);
    expect(r2.alert.severity).toBe('critical');

    // 历史表有 severity 变更记录
    const history = getDb().prepare('SELECT * FROM alert_history WHERE alert_id = ?').all(r1.alert.id);
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  it('资产关联：resource 匹配已登记资产名 → asset_id 自动关联', () => {
    addAsset({ name: 'linked-host', type: 'host', addr: '10.0.0.1' });
    const parsed = detectAndParse({ event: 'CPUHigh', resource: 'linked-host', severity: 'critical' });
    const { alert } = ingestAlert(parsed[0]!);
    expect(alert.assetId).toBeDefined();
  });

  it('失败路径：ack 已关闭的告警 → ASSET_INVALID', () => {
    const parsed = detectAndParse({ event: 'Closed', resource: 'r', severity: 'info' });
    const { alert } = ingestAlert(parsed[0]!);
    closeAlert(alert.id);
    expect(cap(() => ackAlert(alert.id))).toBe('SKYPORT_ASSET_INVALID');
  });

  it('列表与统计', () => {
    ingestAlert(detectAndParse({ event: 'S1', resource: 'r1', severity: 'critical' })[0]!);
    ingestAlert(detectAndParse({ event: 'S2', resource: 'r2', severity: 'warning' })[0]!);
    ingestAlert(detectAndParse({ event: 'S3', resource: 'r3', severity: 'info' })[0]!);
    const all = listAlerts();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const open = listAlerts('open');
    expect(open.every((a) => a.status === 'open')).toBe(true);
    const stats = getAlertStats();
    expect(stats.total).toBeGreaterThanOrEqual(3);
  });

  it('失败路径：不存在的告警 → ASSET_NOT_FOUND', () => {
    expect(cap(() => getAlertById('ghost'))).toBe('SKYPORT_ASSET_NOT_FOUND');
    expect(cap(() => ackAlert('ghost'))).toBe('SKYPORT_ASSET_NOT_FOUND');
  });
});
