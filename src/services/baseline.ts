/**
 * 基线三相训练（PRD §2 知识层）：从指标数据学"什么是正常"。
 * training：积累数据 → shadow：验证基线 → detect：用基线判异常。
 */
import { getDb } from '../adapters/db';

export interface MetricPoint {
  readonly assetId: string;
  readonly metric: string;
  readonly value: number;
  readonly timestamp: string;
}

export interface Baseline {
  readonly assetId: string;
  readonly metric: string;
  readonly p50: number;
  readonly p95: number;
  readonly sampleCount: number;
  readonly computedAt: string;
}

/** 记录一个指标数据点 */
export function recordMetricPoint(assetId: string, metric: string, value: number): void {
  getDb()
    .prepare('INSERT INTO metric_points (asset_id, metric, value, timestamp) VALUES (?, ?, ?, ?)')
    .run(assetId, metric, value, new Date().toISOString());
}

/** 全量基线重算：遍历所有资产×指标（serve 每小时调度 + CLI 手动；样本不足自动跳过） */
export function recomputeAllBaselines(): { computed: number; skipped: number } {
  const pairs = getDb()
    .prepare('SELECT DISTINCT asset_id, metric FROM metric_points')
    .all() as { asset_id: string; metric: string }[];
  let computed = 0;
  let skipped = 0;
  for (const pair of pairs) {
    const result = computeBaseline(pair.asset_id, pair.metric);
    if (result === undefined) skipped += 1;
    else computed += 1;
  }
  return { computed, skipped };
}

/** 指标数据保留：删除 cutoff 之前的原始点（基线已固化聚合值，原始点过期可清） */
export function pruneMetricPoints(retentionDays: number): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000).toISOString();
  const result = getDb().prepare('DELETE FROM metric_points WHERE timestamp < ?').run(cutoff);
  return result.changes;
}

/** 计算某资产某指标的基线（p50/p95） */
export function computeBaseline(assetId: string, metric: string): Baseline | undefined {
  const rows = getDb()
    .prepare('SELECT value FROM metric_points WHERE asset_id = ? AND metric = ? ORDER BY timestamp DESC LIMIT 1000')
    .all(assetId, metric) as { value: number }[];
  if (rows.length < 10) return undefined; // 样本不足，不计算

  const values = rows.map((r) => r.value).sort((a, b) => a - b);
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);

  // Upsert 基线
  getDb()
    .prepare(`INSERT INTO baselines (asset_id, metric, p50, p95, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id, metric) DO UPDATE SET p50 = ?, p95 = ?, sample_count = ?, computed_at = ?`)
    .run(assetId, metric, p50, p95, rows.length, new Date().toISOString(), p50, p95, rows.length, new Date().toISOString());

  return { assetId, metric, p50, p95, sampleCount: rows.length, computedAt: new Date().toISOString() };
}

/** 判断指标值是否偏离基线（shadow/detect 模式用） */
export function isAnomalous(assetId: string, metric: string, value: number): { anomalous: boolean; detail: string } {
  const row = getDb()
    .prepare('SELECT p50, p95 FROM baselines WHERE asset_id = ? AND metric = ?')
    .get(assetId, metric) as { p50: number; p95: number } | undefined;
  if (row === undefined) return { anomalous: false, detail: '基线未建立' };
  if (value > row.p95) return { anomalous: true, detail: `值 ${value} 超过 p95 基线 ${row.p95}` };
  return { anomalous: false, detail: `值 ${value} 在基线范围内（p50=${row.p50}, p95=${row.p95}）` };
}

/** 获取资产全部基线 */
interface BaselineRow {
  asset_id: string;
  metric: string;
  p50: number;
  p95: number;
  sample_count: number;
  computed_at: string;
}

export function getBaselines(assetId: string): Baseline[] {
  const rows = getDb()
    .prepare('SELECT asset_id, metric, p50, p95, sample_count, computed_at FROM baselines WHERE asset_id = ?')
    .all(assetId) as BaselineRow[];
  return rows.map((row) => ({
    assetId: row.asset_id,
    metric: row.metric,
    p50: row.p50,
    p95: row.p95,
    sampleCount: row.sample_count,
    computedAt: row.computed_at,
  }));
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
}
