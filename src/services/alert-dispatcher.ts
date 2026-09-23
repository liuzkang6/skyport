/**
 * 告警闭环调度器（spec/alert-dispatcher，PRD 业务闭环第一环）：
 * 告警进总线后，自动匹配剧本 trigger（alertEvents 事件名 + minSeverity 门槛），
 * 命中即在冷却窗口外触发剧本——经 vendored 引擎受治理执行并留痕 playbook_runs。
 *
 * 设计决定：
 * - 只对"新建告警"触发（去重更新不重复触发）——告警疲劳的第一道闸
 * - 冷却窗口按剧本名全局计算（查 playbook_runs 最近一次 started_at），
 *   重启不丢（状态在库不在内存）
 * - 剧本按自身三相毕业所处的 mode 执行：training/shadow 只记录不执行——
 *   自动触发天然安全，毕业到 detect 才会真动手
 * - 触发者是一个系统 agent（skyport-dispatcher），风险上限与资产范围
 *   受与普通 agent 相同的治理约束
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../adapters/db';
import { rootLogger } from '../logger/logger';
import { createError, ERROR_CODES } from '../errors/errors';
import { BUILTIN_PLAYBOOKS, type PlaybookDefinition, type PlaybookRunResult, type PlaybookMode } from './playbook';
import { executeViaBridge } from './workflow-bridge';
import { createAgent, type ActorRef } from './agents';
import type { Alert } from './alert-bus';

export const DISPATCHER_AGENT_NAME = 'skyport-dispatcher';
/** 同一剧本两次自动触发之间的最小间隔 */
export const TRIGGER_COOLDOWN_MS = 5 * 60_000;

const SEVERITY_ORDER: Readonly<Record<string, number>> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/** 剧本 trigger 与告警的匹配（事件名精确/通配 + severity 门槛） */
export function playbookMatchesAlert(playbook: PlaybookDefinition, alert: Pick<Alert, 'event' | 'severity'>): boolean {
  if (playbook.trigger.alertEvents.length === 0) return false;
  const events = playbook.trigger.alertEvents.map((e) => e.toLowerCase());
  const eventHit = events.some((e) => matchGlob(e, alert.event.toLowerCase()));
  if (!eventHit) return false;
  const min = playbook.trigger.minSeverity === undefined ? 'info' : playbook.trigger.minSeverity;
  const threshold = SEVERITY_ORDER[min] ?? 1;
  const actual = SEVERITY_ORDER[alert.severity] ?? 1;
  return actual >= threshold;
}

function matchGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
  return regex.test(value);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 调度器身份：确保系统 agent 存在（首次使用时自动开通，全局资产、中危上限；不签发可用 key——仅进程内调用） */
export function ensureDispatcherActor(): ActorRef {
  const row = getDb().prepare('SELECT id, name FROM agents WHERE name = ?').get(DISPATCHER_AGENT_NAME) as
    | { id: string; name: string }
    | undefined;
  if (row !== undefined) return { type: 'agent', id: row.id, name: row.name };
  const issued = createAgent({ name: DISPATCHER_AGENT_NAME, assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
  rootLogger.info('告警调度器系统 agent 已开通', { agentId: issued.agent.id });
  return { type: 'agent', id: issued.agent.id, name: DISPATCHER_AGENT_NAME };
}

/** 告警进入时的调度入口（仅对新建告警调用）：命中即触发，冷却窗口内跳过 */
export function dispatchAlertToPlaybooks(alert: Pick<Alert, 'id' | 'event' | 'severity' | 'resource'>): void {
  const matches = BUILTIN_PLAYBOOKS.filter((p) => playbookMatchesAlert(p, alert));
  if (matches.length === 0) return;
  rootLogger.info('告警命中剧本', { alertId: alert.id, event: alert.event, playbooks: matches.map((m) => m.name) });
  // 异步执行：不阻塞告警入库路径；失败记日志不抛（告警链路优先可用）
  for (const playbook of matches) {
    void triggerPlaybook(playbook, 'alert', alert.id).catch((error) => {
      rootLogger.warn('剧本自动触发失败', { alertId: alert.id, playbook: playbook.name, error: error instanceof Error ? error.message : String(error) });
    });
  }
}

/** 手动触发（REST / CLI） */
export async function triggerPlaybookByName(name: string, actor: ActorRef): Promise<PlaybookRunResult> {
  const playbook = BUILTIN_PLAYBOOKS.find((p) => p.name === name);
  if (playbook === undefined) {
    throw createError(ERROR_CODES.ACTION_NOT_FOUND, `剧本不存在: ${name}`, { context: { playbook: name } });
  }
  return triggerPlaybook(playbook, 'manual', undefined, actor);
}

/** 触发一个剧本：冷却检查 → vendored 引擎执行 → 留痕 */
async function triggerPlaybook(
  playbook: PlaybookDefinition,
  triggerType: 'alert' | 'manual',
  triggerAlertId: string | undefined,
  actorOverride: ActorRef | undefined = undefined,
): Promise<PlaybookRunResult> {
  if (triggerType === 'alert') {
    const last = getDb()
      .prepare("SELECT started_at FROM playbook_runs WHERE playbook_name = ? AND trigger_type = 'alert' ORDER BY started_at DESC LIMIT 1")
      .get(playbook.name) as { started_at: string } | undefined;
    if (last !== undefined && Date.now() - Date.parse(last.started_at) < TRIGGER_COOLDOWN_MS) {
      rootLogger.info('剧本冷却窗口内，跳过自动触发', { playbook: playbook.name, lastRun: last.started_at });
      return recordSkippedRun(playbook);
    }
  }
  const actor = actorOverride ?? ensureDispatcherActor();
  const result = await executeViaBridge(playbook, actor);
  recordPlaybookRun(playbook, result, triggerType, triggerAlertId, actor);
  return result;
}

// ── 运行留痕 ─────────────────────────────

interface PlaybookRunRow {
  id: number;
  run_id: string;
  playbook_name: string;
  mode: string;
  status: string;
  trigger_type: string;
  trigger_alert_id: string | null;
  triggered_by: string;
  steps_json: string;
  started_at: string;
  completed_at: string | null;
}

function recordPlaybookRun(
  playbook: PlaybookDefinition,
  result: PlaybookRunResult,
  triggerType: 'alert' | 'manual',
  triggerAlertId: string | undefined,
  actor: ActorRef,
): void {
  getDb().prepare(
    `INSERT INTO playbook_runs (run_id, playbook_name, mode, status, trigger_type, trigger_alert_id, triggered_by, steps_json, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.runId, playbook.name, result.mode, result.status, triggerType, triggerAlertId ?? null,
    `${actor.type}:${actor.id}`, JSON.stringify(result.steps), result.startedAt, result.completedAt ?? null,
  );
}

function recordSkippedRun(playbook: PlaybookDefinition): PlaybookRunResult {
  const now = new Date().toISOString();
  return {
    playbookId: `pb_${randomBytes(4).toString('hex')}`,
    runId: `run_skipped_${randomBytes(4).toString('hex')}`,
    mode: playbook.mode,
    status: playbook.mode === 'shadow' ? 'shadow-completed' : 'completed',
    steps: [],
    startedAt: now,
    completedAt: now, // 冷却跳过不落库（不占用毕业统计），仅作为返回值传递给调用方诊断
  };
}

export interface PlaybookRunSummary {
  readonly id: number;
  readonly runId: string;
  readonly playbookName: string;
  readonly mode: PlaybookMode;
  readonly status: string;
  readonly triggerType: string;
  readonly triggerAlertId: string | undefined;
  readonly triggeredBy: string;
  readonly startedAt: string;
  readonly completedAt: string | undefined;
  readonly stepCount: number;
}

export function listPlaybookRuns(limit = 50): PlaybookRunSummary[] {
  const rows = getDb()
    .prepare('SELECT * FROM playbook_runs ORDER BY started_at DESC LIMIT ?')
    .all(limit) as PlaybookRunRow[];
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    playbookName: row.playbook_name,
    mode: row.mode as PlaybookMode,
    status: row.status,
    triggerType: row.trigger_type,
    triggerAlertId: row.trigger_alert_id ?? undefined,
    triggeredBy: row.triggered_by,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    stepCount: (JSON.parse(row.steps_json) as unknown[]).length,
  }));
}

/** 毕业统计：某剧本的各相运行次数（数据源 playbook_runs） */
export function graduationRecords(playbookName: string): { mode: PlaybookMode; count: number }[] {
  const rows = getDb()
    .prepare("SELECT mode, COUNT(*) AS n FROM playbook_runs WHERE playbook_name = ? AND status IN ('completed', 'shadow-completed') GROUP BY mode")
    .all(playbookName) as { mode: string; n: number }[];
  return rows.map((row) => ({ mode: row.mode as PlaybookMode, count: row.n }));
}
