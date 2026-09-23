/**
 * 治理月报 + 交接班（PRD v0.7）：审计链数据自动聚合，一键生成合规报告。
 */
import { getDb } from '../adapters/db';
import { verifyAuditChain } from './audit-chain';
import { getUsageSummary } from './usage';
import { getAlertStats } from './alert-bus';

export interface GovernanceReport {
  readonly period: { readonly since: string; readonly until: string };
  readonly actions: {
    readonly total: number;
    readonly byStatus: Record<string, number>;
    readonly byRisk: Record<string, number>;
    readonly byActorType: Record<string, number>;
    readonly topCommands: { command: string; cnt: number }[];
  };
  readonly alerts: Record<string, number>;
  readonly usage: {
    readonly totalPromptTokens: number;
    readonly totalCompletionTokens: number;
    readonly totalCostUsd: number;
    readonly byModel: Record<string, { prompt: number; completion: number; cost: number }>;
  };
  readonly audit: { readonly chainIntact: boolean; readonly checked: number };
  readonly generatedAt: string;
}

export function generateReport(sinceHours = 24 * 30): GovernanceReport {
  const until = new Date();
  const since = new Date(until.getTime() - sinceHours * 3_600_000);
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  const db = getDb();

  // 行动统计
  const statusRows = db.prepare(
    'SELECT status, COUNT(*) as cnt FROM actions WHERE created_at >= ? GROUP BY status',
  ).all(sinceIso) as { status: string; cnt: number }[];
  const byStatus: Record<string, number> = {};
  let actionTotal = 0;
  for (const r of statusRows) { byStatus[r.status] = r.cnt; actionTotal += r.cnt; }

  const riskRows = db.prepare(
    'SELECT risk_level, COUNT(*) as cnt FROM actions WHERE created_at >= ? GROUP BY risk_level',
  ).all(sinceIso) as { risk_level: string; cnt: number }[];
  const byRisk: Record<string, number> = {};
  for (const r of riskRows) byRisk[r.risk_level] = r.cnt;

  const actorRows = db.prepare(
    'SELECT actor_type, COUNT(*) as cnt FROM actions WHERE created_at >= ? GROUP BY actor_type',
  ).all(sinceIso) as { actor_type: string; cnt: number }[];
  const byActorType: Record<string, number> = {};
  for (const r of actorRows) byActorType[r.actor_type] = r.cnt;

  const topCmdRows = db.prepare(
    'SELECT command, COUNT(*) as cnt FROM actions WHERE created_at >= ? GROUP BY command ORDER BY cnt DESC LIMIT 10',
  ).all(sinceIso) as { command: string; cnt: number }[];

  // 告警统计
  const alerts = getAlertStats();

  // Token 用量
  const usage = getUsageSummary(sinceHours);

  // 审计链
  const chain = verifyAuditChain();

  return {
    period: { since: sinceIso, until: untilIso },
    actions: { total: actionTotal, byStatus, byRisk, byActorType, topCommands: topCmdRows },
    alerts,
    usage: {
      totalPromptTokens: usage.totalPromptTokens,
      totalCompletionTokens: usage.totalCompletionTokens,
      totalCostUsd: usage.totalCostUsd,
      byModel: Object.fromEntries(
        Object.entries(usage.byModel).map(([k, v]) => [k, { prompt: v.prompt, completion: v.completion, cost: v.cost }]),
      ),
    },
    audit: { chainIntact: chain.ok, checked: chain.checked },
    generatedAt: untilIso,
  };
}

export interface HandoverSnapshot {
  readonly generatedAt: string;
  readonly openAlerts: { id: string; event: string; severity: string; resource: string }[];
  readonly pendingActions: { id: string; command: string; riskLevel: string; actorType: string; createdAt: string }[];
  readonly assetHealth: { name: string; status: string }[];
  readonly notes: string;
}

export function createHandover(notes: string, createdBy: string): HandoverSnapshot {
  const db = getDb();
  const openAlerts = (db.prepare("SELECT id, event, severity, resource FROM alerts WHERE status = 'open'").all() as
    { id: string; event: string; severity: string; resource: string }[]);
  const pendingActions = (db.prepare(
    "SELECT id, command, risk_level as riskLevel, actor_type as actorType, created_at as createdAt FROM actions WHERE status = 'pending'",
  ).all() as { id: string; command: string; riskLevel: string; actorType: string; createdAt: string }[]);
  const assetHealth = (db.prepare('SELECT name, status FROM assets ORDER BY name').all() as
    { name: string; status: string }[]);

  const snapshot: HandoverSnapshot = { generatedAt: new Date().toISOString(), openAlerts, pendingActions, assetHealth, notes };
  // 落库留痕（spec/governance：交接班历史可回溯，不只一次性快照）
  db.prepare('INSERT INTO handovers (generated_at, snapshot_json, created_by) VALUES (?, ?, ?)').run(
    snapshot.generatedAt, JSON.stringify(snapshot), createdBy,
  );
  return snapshot;
}

/** 最近一次交接班快照（无历史返回 undefined） */
export function getLatestHandover(): { generatedAt: string; createdBy: string; snapshot: HandoverSnapshot } | undefined {
  const row = getDb().prepare('SELECT generated_at, snapshot_json, created_by FROM handovers ORDER BY id DESC LIMIT 1').get() as
    | { generated_at: string; snapshot_json: string; created_by: string }
    | undefined;
  if (row === undefined) return undefined;
  return { generatedAt: row.generated_at, createdBy: row.created_by, snapshot: JSON.parse(row.snapshot_json) as HandoverSnapshot };
}
