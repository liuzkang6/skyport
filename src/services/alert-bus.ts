/**
 * 告警总线（spec/alert-bus/spec.md）：Alerta 模型 + 三格式适配器 + 去重关联 + ACK SLA。
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../adapters/db';
import { httpRequest } from '../adapters/http';
import { getConfig } from '../config/config';
import { createError, ERROR_CODES } from '../errors/errors';
import { rootLogger } from '../logger/logger';
import { z } from 'zod';

export const ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export type AlertStatus = 'open' | 'ack' | 'closed';

export interface Alert {
  readonly id: string;
  readonly event: string;
  readonly resource: string;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly value: string | undefined;
  readonly text: string | undefined;
  readonly tags: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly correlate: readonly string[];
  readonly origin: string;
  readonly assetId: string | undefined;
  readonly timestamp: string;
  readonly escalated: boolean;
}

export interface IngestResult {
  readonly alert: Alert;
  readonly created: boolean;
}

// ── 格式适配器 ─────────────────────────────────────

/** Alertmanager webhook 格式 */
interface AlertmanagerAlert {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  value?: string;
}

function parseAlertmanager(body: unknown): ParsedAlert[] {
  const b = body as { alerts?: AlertmanagerAlert[] };
  if (!Array.isArray(b.alerts)) return [];
  return b.alerts.map((raw) => ({
    event: String(raw.labels?.alertname ?? 'unknown'),
    resource: String(raw.labels?.instance ?? raw.labels?.resource ?? 'unknown'),
    severity: mapAlertmanagerSeverity(String(raw.labels?.severity ?? 'warning')),
    value: raw.value,
    text: String(raw.annotations?.summary ?? raw.annotations?.description ?? ''),
    tags: Object.entries(raw.labels ?? {}).map(([k, v]) => `${k}=${v}`),
    attributes: (raw.annotations ?? {}) as Record<string, unknown>,
    origin: 'alertmanager',
  }));
}

function mapAlertmanagerSeverity(s: string): AlertSeverity {
  if (s === 'critical' || s === 'page') return 'critical';
  if (s === 'warning' || s === 'warning') return 'warning';
  return 'info';
}

/** Zabbix webhook 格式 */
interface ZabbixBody {
  eventid?: string;
  event_name?: string;
  host?: { name?: string };
  hostname?: string;
  trigger?: { description?: string; priority?: number; comments?: string };
  severity?: number;
  value?: string;
  message?: string;
}

function parseZabbix(body: unknown): ParsedAlert[] {
  const b = body as ZabbixBody;
  if (b.eventid === undefined && b.trigger === undefined) return [];
  return [{
    event: String(b.trigger?.description ?? b.event_name ?? 'Zabbix Trigger'),
    resource: String(b.host?.name ?? b.hostname ?? 'unknown'),
    severity: mapZabbixSeverity(Number(b.trigger?.priority ?? b.severity ?? 1)),
    value: b.value,
    text: String(b.trigger?.comments ?? b.message ?? ''),
    tags: [`zabbix=eventid:${b.eventid ?? ''}`],
    attributes: b as Record<string, unknown>,
    origin: 'zabbix',
  }];
}

function mapZabbixSeverity(n: number): AlertSeverity {
  if (n >= 4) return 'critical';
  if (n >= 2) return 'warning';
  return 'info';
}

/** skyport 原生格式 */
const nativeSchema = z.object({
  event: z.string().min(1),
  resource: z.string().min(1),
  severity: z.enum(ALERT_SEVERITIES),
  value: z.string().optional(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  origin: z.string().optional(),
});

function parseNative(body: unknown): ParsedAlert[] {
  const parsed = nativeSchema.safeParse(body);
  if (!parsed.success) return [];
  const d = parsed.data;
  return [{
    event: d.event,
    resource: d.resource,
    severity: d.severity,
    value: d.value ?? undefined,
    text: d.text ?? '',
    tags: d.tags ?? [],
    attributes: d.attributes ?? {},
    origin: d.origin ?? 'api',
  }];
}

interface ParsedAlert {
  event: string;
  resource: string;
  severity: AlertSeverity;
  value: string | undefined; // eslint-disable-line
  text: string;
  tags: string[];
  attributes: Record<string, unknown>;
  origin: string;
}

/** 自动检测格式并解析 */
export function detectAndParse(body: unknown): ParsedAlert[] {
  for (const parser of [parseAlertmanager, parseZabbix, parseNative]) {
    const result = parser(body);
    if (result.length > 0) return result;
  }
  return [];
}

// ── 核心操作 ─────────────────────────────────────

export function ingestAlert(parsed: ParsedAlert): IngestResult {
  const dedupKey = `${parsed.resource}|${parsed.event}|${parsed.origin}`;
  const existing = getDb().prepare('SELECT * FROM alerts WHERE dedup_key = ?').get(dedupKey) as AlertRow | undefined;

  if (existing) {
    // 去重更新：severity 变化记历史，不新建
    if (existing.severity !== parsed.severity) {
      getDb().prepare('INSERT INTO alert_history (alert_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?)')
        .run(existing.id, 'severity', existing.severity, parsed.severity, new Date().toISOString());
    }
    getDb().prepare('UPDATE alerts SET severity = ?, value = ?, text = ?, tags = ?, attributes = ?, updated_at = ? WHERE id = ?')
      .run(parsed.severity, parsed.value ?? null, parsed.text, JSON.stringify(parsed.tags), JSON.stringify(parsed.attributes), new Date().toISOString(), existing.id);
    return { alert: getAlertById(existing.id), created: false };
  }

  const now = new Date().toISOString();
  const id = `alt_${randomBytes(4).toString('hex')}`;
  const assetId = correlateToAsset(parsed.resource);
  getDb().prepare(
    `INSERT INTO alerts (id, event, resource, severity, status, value, text, tags, attributes, correlate, origin, asset_id, timestamp, created_at, updated_at, dedup_key)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
  ).run(id, parsed.event, parsed.resource, parsed.severity, parsed.value ?? null, parsed.text, JSON.stringify(parsed.tags), JSON.stringify(parsed.attributes), parsed.origin, assetId, now, now, now, dedupKey);
  return { alert: getAlertById(id), created: true };
}

export function getAlertById(id: string): Alert {
  const row = getDb().prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
  if (row === undefined) throw createError(ERROR_CODES.ASSET_NOT_FOUND, `告警不存在: ${id}`, { context: { id } });
  return rowToAlert(row);
}

export function listAlerts(status?: AlertStatus): Alert[] {
  const rows = status === undefined
    ? getDb().prepare('SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 200').all()
    : getDb().prepare('SELECT * FROM alerts WHERE status = ? ORDER BY timestamp DESC LIMIT 200').all(status);
  return (rows as AlertRow[]).map(rowToAlert);
}

export function ackAlert(id: string): Alert {
  const alert = getAlertById(id);
  if (alert.status === 'closed') throw createError(ERROR_CODES.ASSET_INVALID, '已关闭的告警不能确认', { context: { id } });
  getDb().prepare("UPDATE alerts SET status = 'ack', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return getAlertById(id);
}

export function closeAlert(id: string): Alert {
  getAlertById(id); // 存在性检查
  getDb().prepare("UPDATE alerts SET status = 'closed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return getAlertById(id);
}

export function getAlertStats(): Record<string, number> {
  const rows = getDb().prepare('SELECT status, severity, COUNT(*) as cnt FROM alerts GROUP BY status, severity').all() as { status: string; severity: string; cnt: number }[];
  const stats: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    stats[`${row.status}_${row.severity}`] = row.cnt;
    total += row.cnt;
  }
  stats.total = total;
  return stats;
}

/** 资产关联：按资源名匹配 */
function correlateToAsset(resource: string): string | null {
  const row = getDb().prepare('SELECT id FROM assets WHERE name = ? OR addr LIKE ?').get(resource, `%${resource}%`) as { id: string } | undefined;
  return row?.id ?? null;
}

/** ACK SLA 检查（由 serve 定期调用） */
export async function checkAckSla(): Promise<number> {
  const webhookUrl = (getConfig() as unknown as { notifyWebhookUrl?: string }).notifyWebhookUrl;
  const now = Date.now();
  const SLA = { critical: 5 * 60_000, warning: 30 * 60_000 };
  const rows = getDb().prepare("SELECT * FROM alerts WHERE status = 'open' AND escalated = 0").all() as AlertRow[];
  let escalated = 0;
  for (const row of rows) {
    const ageMs = now - Date.parse(row.timestamp);
    const limit = SLA[row.severity as keyof typeof SLA] ?? Infinity;
    if (ageMs > limit) {
      getDb().prepare('UPDATE alerts SET escalated = 1 WHERE id = ?').run(row.id);
      escalated += 1;
      if (webhookUrl !== undefined) {
        try {
          await httpRequest(webhookUrl, {
            method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs: 5_000,
            body: JSON.stringify({ event: 'skyport.alert.escalated', alertId: row.id, severity: row.severity, resource: row.resource, event_name: row.event, ageMinutes: Math.round(ageMs / 60_000) }),
          });
        } catch { /* 升级通知失败不阻断 */ }
      }
      rootLogger.warn('告警 ACK 超时升级', { alertId: row.id, severity: row.severity, ageMinutes: Math.round(ageMs / 60_000) });
    }
  }
  return escalated;
}

// ── 行映射 ─────────────────────────────────────

interface AlertRow {
  id: string; event: string; resource: string; severity: string; status: string;
  value: string | null; text: string | null; tags: string; attributes: string;
  correlate: string; origin: string; asset_id: string | null; timestamp: string;
  escalated: number; created_at: string; updated_at: string;
}

function rowToAlert(row: AlertRow): Alert {
  return {
    id: row.id, event: row.event, resource: row.resource,
    severity: row.severity as AlertSeverity, status: row.status as AlertStatus,
    value: row.value ?? undefined, text: row.text ?? undefined,
    tags: JSON.parse(row.tags), attributes: JSON.parse(row.attributes),
    correlate: JSON.parse(row.correlate), origin: row.origin,
    assetId: row.asset_id ?? undefined, timestamp: row.timestamp,
    escalated: row.escalated === 1,
  };
}
