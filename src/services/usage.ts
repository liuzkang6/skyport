/**
 * Token 用量治理（PRD §2）：认证运行时强制上报用量，看板+预算告警。
 */
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';

export interface UsageEvent {
  readonly agentId: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly actionId: string | undefined;
}

export interface UsageSummary {
  readonly totalPromptTokens: number;
  readonly totalCompletionTokens: number;
  readonly totalCostUsd: number;
  readonly byModel: Record<string, { prompt: number; completion: number; cost: number }>;
  readonly byAgent: Record<string, { prompt: number; completion: number; cost: number }>;
}

export function recordUsage(event: UsageEvent): void {
  if (event.promptTokens < 0 || event.completionTokens < 0 || event.costUsd < 0) {
    throw createError(ERROR_CODES.AGENT_INVALID, '用量数据不能为负数', { context: { ...event } });
  }
  getDb()
    .prepare('INSERT INTO usage_events (agent_id, model, prompt_tokens, completion_tokens, cost_usd, action_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(event.agentId, event.model, event.promptTokens, event.completionTokens, event.costUsd, event.actionId ?? null, new Date().toISOString());
}

export function getUsageSummary(sinceHours = 24): UsageSummary {
  const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
  const rows = getDb()
    .prepare('SELECT agent_id, model, prompt_tokens, completion_tokens, cost_usd FROM usage_events WHERE created_at >= ?')
    .all(since) as { agent_id: string; model: string; prompt_tokens: number; completion_tokens: number; cost_usd: number }[];

  const byModel: Record<string, { prompt: number; completion: number; cost: number }> = {};
  const byAgent: Record<string, { prompt: number; completion: number; cost: number }> = {};
  let totalPrompt = 0, totalCompletion = 0, totalCost = 0;

  for (const row of rows) {
    totalPrompt += row.prompt_tokens;
    totalCompletion += row.completion_tokens;
    totalCost += row.cost_usd;
    const m = byModel[row.model] ?? { prompt: 0, completion: 0, cost: 0 };
    m.prompt += row.prompt_tokens; m.completion += row.completion_tokens; m.cost += row.cost_usd;
    byModel[row.model] = m;
    const a = byAgent[row.agent_id] ?? { prompt: 0, completion: 0, cost: 0 };
    a.prompt += row.prompt_tokens; a.completion += row.completion_tokens; a.cost += row.cost_usd;
    byAgent[row.agent_id] = a;
  }

  return { totalPromptTokens: totalPrompt, totalCompletionTokens: totalCompletion, totalCostUsd: totalCost, byModel, byAgent };
}

/** 预算告警检查：超阈值返回告警列表 */
export function checkBudgetAlerts(dailyBudgetUsd: number): { agentId: string; costUsd: number }[] {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = getDb()
    .prepare('SELECT agent_id, SUM(cost_usd) as cost FROM usage_events WHERE created_at >= ? GROUP BY agent_id HAVING cost > ?')
    .all(since, dailyBudgetUsd) as { agent_id: string; cost: number }[];
  return rows.map((r) => ({ agentId: r.agent_id, costUsd: r.cost }));
}
