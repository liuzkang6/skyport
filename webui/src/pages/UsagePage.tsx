/**
 * Token 用量看板（PRD v0.7）：按模型/agent 分组展示消耗，支持时间范围切换。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';

interface UsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { prompt: number; completion: number; cost: number }>;
  byAgent: Record<string, { prompt: number; completion: number; cost: number }>;
}

export function UsagePage() {
  const [data, setData] = useState<UsageSummary | undefined>(undefined);
  const [hours, setHours] = useState(24);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async (h: number) => {
    try {
      setData((await api.usageSummary(h)) as unknown as UsageSummary);
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => { void load(hours); }, [hours, load]);

  if (error !== undefined) return <div className="p-6 text-ui-base text-destructive">{error}</div>;
  if (data === undefined) return <div className="p-6 text-ui-caption text-foreground-subtle">加载中…</div>;

  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-4">
        <h1 className="text-ui-lg font-semibold">Token 用量</h1>
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className="rounded-lg border border-input-border bg-input px-2 py-1 text-ui-sm text-foreground"
        >
          <option value={1}>1 小时</option>
          <option value={24}>24 小时</option>
          <option value={168}>7 天</option>
        </select>
      </div>

      <div className="mb-6 grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="text-ui-xs text-foreground-subtle">总 Prompt Tokens</div>
          <div className="mt-1 text-ui-xl font-semibold">{fmt(data.totalPromptTokens)}</div>
        </div>
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="text-ui-xs text-foreground-subtle">总 Completion Tokens</div>
          <div className="mt-1 text-ui-xl font-semibold">{fmt(data.totalCompletionTokens)}</div>
        </div>
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="text-ui-xs text-foreground-subtle">总成本 (USD)</div>
          <div className="mt-1 text-ui-xl font-semibold">${data.totalCostUsd.toFixed(2)}</div>
        </div>
      </div>

      <h2 className="mb-2 text-ui-base font-medium">按模型</h2>
      <table className="mb-6 w-full rounded-lg border border-card-border bg-card text-ui-sm">
        <thead>
          <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
            <th className="px-4 py-2 text-left">模型</th>
            <th className="px-4 py-2 text-right">Prompt</th>
            <th className="px-4 py-2 text-right">Completion</th>
            <th className="px-4 py-2 text-right">成本</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.byModel).map(([model, v]) => (
            <tr key={model} className="border-b border-card-border last:border-0">
              <td className="px-4 py-2 font-mono">{model}</td>
              <td className="px-4 py-2 text-right">{fmt(v.prompt)}</td>
              <td className="px-4 py-2 text-right">{fmt(v.completion)}</td>
              <td className="px-4 py-2 text-right">${v.cost.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.keys(data.byModel).length === 0 && <div className="mt-2 text-ui-caption text-foreground-subtle">暂无数据（周期内没有 LLM 调用）</div>}

      <h2 className="mb-2 text-ui-base font-medium">按 Agent</h2>
      <table className="w-full rounded-lg border border-card-border bg-card text-ui-sm">
        <thead>
          <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
            <th className="px-4 py-2 text-left">Agent</th>
            <th className="px-4 py-2 text-right">Prompt</th>
            <th className="px-4 py-2 text-right">Completion</th>
            <th className="px-4 py-2 text-right">成本</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.byAgent).map(([agent, v]) => (
            <tr key={agent} className="border-b border-card-border last:border-0">
              <td className="px-4 py-2 font-mono">{agent}</td>
              <td className="px-4 py-2 text-right">{fmt(v.prompt)}</td>
              <td className="px-4 py-2 text-right">{fmt(v.completion)}</td>
              <td className="px-4 py-2 text-right">${v.cost.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.keys(data.byAgent).length === 0 && <div className="mt-2 text-ui-caption text-foreground-subtle">暂无数据（周期内没有 LLM 调用）</div>}
    </div>
  );
}
