import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { addAsset } from './assets';
import { computeBaseline, getBaselines, pruneMetricPoints, recordMetricPoint, recomputeAllBaselines, isAnomalous } from './baseline';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-baseline-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('基线数据积累闭环（spec/baseline）', () => {
  it('全量重算：多资产多指标各算各的；样本不足跳过', () => {
    const a1 = addAsset({ name: 'b1', type: 'host', addr: '10.0.0.1' });
    const a2 = addAsset({ name: 'b2', type: 'host', addr: '10.0.0.2' });
    // b1 两项指标样本充足
    for (let i = 0; i < 50; i += 1) {
      recordMetricPoint(a1.id, 'cpu_usage', 10 + (i % 5));
      recordMetricPoint(a1.id, 'mem_usage', 40 + (i % 3));
    }
    // b2 样本不足（3 < 10）
    for (let i = 0; i < 3; i += 1) recordMetricPoint(a2.id, 'cpu_usage', 5);

    const report = recomputeAllBaselines();
    expect(report.computed).toBe(2); // b1 的两项
    expect(report.skipped).toBe(1); // b2 的 cpu

    const b1Baselines = getBaselines(a1.id);
    expect(b1Baselines.map((b) => b.metric).sort()).toEqual(['cpu_usage', 'mem_usage']);
    // p50 落在数据范围内
    const cpu = b1Baselines.find((b) => b.metric === 'cpu_usage')!;
    expect(cpu.p50).toBeGreaterThanOrEqual(10);
    expect(cpu.p50).toBeLessThanOrEqual(14);
    expect(cpu.sampleCount).toBe(50);
  });

  it('重算是幂等的 upsert（二次运行更新而非重复插入）', () => {
    const a = addAsset({ name: 'b3', type: 'host', addr: '10.0.0.3' });
    for (let i = 0; i < 20; i += 1) recordMetricPoint(a.id, 'disk_usage', 50 + i * 0.1);
    recomputeAllBaselines();
    recomputeAllBaselines();
    expect(getBaselines(a.id)).toHaveLength(1);
  });

  it('异常检测：最新值超 p95×1.2 判异常', () => {
    const a = addAsset({ name: 'b4', type: 'host', addr: '10.0.0.4' });
    for (let i = 0; i < 100; i += 1) recordMetricPoint(a.id, 'log_error_rate_5m', i % 10); // 0..9
    computeBaseline(a.id, 'log_error_rate_5m');
    expect(isAnomalous(a.id, 'log_error_rate_5m', 3).anomalous).toBe(false); // 正常水位
    const spike = isAnomalous(a.id, 'log_error_rate_5m', 100); // 日志错误突增
    expect(spike.anomalous).toBe(true);
    expect(spike.detail).toContain('p95');
  });

  it('保留清理：过期点删除、新点保留', () => {
    const a = addAsset({ name: 'b5', type: 'host', addr: '10.0.0.5' });
    const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    getDb().prepare('INSERT INTO metric_points (asset_id, metric, value, timestamp) VALUES (?, ?, ?, ?)').run(a.id, 'cpu_usage', 1, old);
    recordMetricPoint(a.id, 'cpu_usage', 2);
    const pruned = pruneMetricPoints(30);
    expect(pruned).toBe(1);
    const remain = getDb().prepare('SELECT COUNT(*) AS n FROM metric_points').get() as { n: number };
    expect(remain.n).toBe(1);
  });
});
