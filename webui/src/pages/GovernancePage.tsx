/**
 * 治理页（PRD v0.7）：治理月报 + 交接班两个标签。
 * 月报 = 审计链数据自动聚合（行动/告警/用量/链完整性）；
 * 交接班 = 一键生成现场快照（开放告警/待审批/资产健康 + 手写备注）。
 */
import { useCallback, useEffect, useState } from 'react';

interface GovernanceReport {
  period: { since: string; until: string };
  actions: {
    total: number;
    byStatus: Record<string, number>;
    byRisk: Record<string, number>;
    byActorType: Record<string, number>;
    topCommands: { command: string; cnt: number }[];
  };
  alerts: Record<string, number>;
  usage: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCostUsd: number;
    byModel: Record<string, { prompt: number; completion: number; cost: number }>;
  };
  audit: { chainIntact: boolean; checked: number };
  generatedAt: string;
}

interface HandoverSnapshot {
  generatedAt: string;
  openAlerts: { id: string; event: string; severity: string; resource: string }[];
  pendingActions: { id: string; command: string; riskLevel: string; actorType: string; createdAt: string }[];
  assetHealth: { name: string; status: string }[];
  notes: string;
}

type Tab = 'report' | 'handover';

const STATUS_LABEL: Record<string, string> = {
  pending: '待审批', approved: '已放行', executing: '执行中', success: '成功', failed: '失败',
  rejected: '已否决', cancelled: '已取消', expired: '已过期',
};

function CountTable({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div className="rounded-xl border border-card-border bg-card p-4">
      <h3 className="mb-2 text-ui-sm font-medium text-foreground-subtle">{title}</h3>
      {rows.length === 0 ? (
        <div className="text-ui-caption text-foreground-subtlest">无数据</div>
      ) : (
        <table className="w-full text-ui-sm">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="py-0.5 font-mono">{STATUS_LABEL[k] ?? k}</td>
                <td className="py-0.5 text-right font-mono">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function GovernancePage() {
  const [tab, setTab] = useState<Tab>('report');
  const [hours, setHours] = useState(720);
  const [report, setReport] = useState<GovernanceReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const loadReport = useCallback(async (h: number) => {
    try {
      const res = await fetch(`/api/v1/governance/report?hours=${h}`, { credentials: 'include' });
      if (!res.ok) { setError(`加载失败: ${res.status}`); return; }
      setReport((await res.json()) as GovernanceReport);
      setError(undefined);
    } catch { setError('网络不可达'); }
  }, []);

  useEffect(() => { if (tab === 'report') void loadReport(hours); }, [tab, hours, loadReport]);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="mr-4 text-ui-lg font-semibold">治理</h1>
        <button
          type="button"
          onClick={() => setTab('report')}
          className={`rounded-lg px-3 py-1 text-ui-sm ${tab === 'report' ? 'bg-selected font-medium text-foreground' : 'text-foreground-subtle hover:bg-hover'}`}
        >
          治理月报
        </button>
        <button
          type="button"
          onClick={() => setTab('handover')}
          className={`rounded-lg px-3 py-1 text-ui-sm ${tab === 'handover' ? 'bg-selected font-medium text-foreground' : 'text-foreground-subtle hover:bg-hover'}`}
        >
          交接班
        </button>
        {tab === 'report' && (
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="ml-auto rounded-lg border border-input-border bg-input px-2 py-1 text-ui-sm text-foreground"
          >
            <option value={24}>24 小时</option>
            <option value={168}>7 天</option>
            <option value={720}>30 天</option>
          </select>
        )}
      </div>

      {error !== undefined && <div className="mb-4 text-ui-base text-destructive">{error}</div>}
      {tab === 'report' ? <ReportView report={report} /> : <HandoverView />}
    </div>
  );
}

function ReportView({ report }: { report: GovernanceReport | undefined }) {
  if (report === undefined) return <div className="text-ui-caption text-foreground-subtle">加载中…</div>;
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
  return (
    <div>
      <div className={`mb-6 rounded-xl border p-4 ${report.audit.chainIntact ? 'border-card-border bg-card' : 'border-destructive bg-destructive/10'}`}>
        <div className="flex items-center gap-2">
          <span className={report.audit.chainIntact ? 'text-positive' : 'text-destructive'}>{report.audit.chainIntact ? '✓' : '✗'}</span>
          <span className="text-ui-base font-medium">审计链 {report.audit.chainIntact ? '完整' : '已断裂'}</span>
          <span className="text-ui-caption text-foreground-subtle">（校验 {report.audit.checked} 条记录）</span>
          <span className="ml-auto text-ui-caption text-foreground-subtlest">周期 {report.period.since.slice(0, 10)} ~ {report.period.until.slice(0, 10)}</span>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-4 gap-4">
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="text-ui-xs text-foreground-subtle">行动总数</div>
          <div className="mt-1 text-ui-xl font-semibold">{report.actions.total}</div>
        </div>
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="text-ui-xs text-foreground-subtle">开放告警</div>
          <div className="mt-1 text-ui-xl font-semibold">{report.alerts.open ?? 0}</div>
        </div>
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="text-ui-xs text-foreground-subtle">Token 消耗</div>
          <div className="mt-1 text-ui-xl font-semibold">{fmt(report.usage.totalPromptTokens + report.usage.totalCompletionTokens)}</div>
        </div>
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="text-ui-xs text-foreground-subtle">总成本 (USD)</div>
          <div className="mt-1 text-ui-xl font-semibold">${report.usage.totalCostUsd.toFixed(2)}</div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-3 gap-4">
        <CountTable title="行动 × 状态" rows={Object.entries(report.actions.byStatus)} />
        <CountTable title="行动 × 风险级" rows={Object.entries(report.actions.byRisk)} />
        <CountTable title="行动 × 操作者" rows={Object.entries(report.actions.byActorType)} />
      </div>

      <h2 className="mb-2 text-ui-base font-medium">高频命令 Top10</h2>
      <table className="w-full rounded-lg border border-card-border bg-card text-ui-sm">
        <thead>
          <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
            <th className="px-4 py-2 text-left">命令</th>
            <th className="px-4 py-2 text-right">次数</th>
          </tr>
        </thead>
        <tbody>
          {report.actions.topCommands.length === 0 ? (
            <tr><td className="px-4 py-3 text-foreground-subtlest" colSpan={2}>周期内无行动</td></tr>
          ) : report.actions.topCommands.map((c) => (
            <tr key={c.command} className="border-b border-card-border last:border-0">
              <td className="break-all px-4 py-2 font-mono">{c.command}</td>
              <td className="px-4 py-2 text-right font-mono">{c.cnt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HandoverView() {
  const [snapshot, setSnapshot] = useState<HandoverSnapshot | undefined>(undefined);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // 打开即预载最近一次交接班（spec/governance：交接班历史可回溯）
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/v1/handover/latest', { credentials: 'include' });
        if (!res.ok) return;
        const body = (await res.json()) as { snapshot?: HandoverSnapshot };
        if (body.snapshot !== undefined) setSnapshot(body.snapshot);
      } catch { /* 静默 */ }
    })();
  }, []);

  const generate = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/v1/handover', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) { setError(`生成失败: ${res.status}`); return; }
      setSnapshot((await res.json()) as HandoverSnapshot);
      setError(undefined);
    } catch { setError('网络不可达'); }
    finally { setBusy(false); }
  }, [notes]);

  return (
    <div>
      <div className="mb-4 rounded-xl border border-card-border bg-card p-4">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="交接备注：未完成的处置、观察中的异常、需接手人注意的事项…"
          rows={3}
          className="w-full resize-none rounded-lg border border-input-border bg-input px-3 py-2 text-ui-sm text-foreground placeholder:text-foreground-subtlest"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void generate()}
          className="mt-2 rounded-lg bg-primary px-4 py-1.5 text-ui-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '生成中…' : '生成交接班快照'}
        </button>
        {error !== undefined && <span className="ml-3 text-ui-sm text-destructive">{error}</span>}
      </div>

      {snapshot === undefined ? (
        <div className="text-ui-caption text-foreground-subtle">点击上方按钮，按当前系统现场生成快照</div>
      ) : (
        <div>
          <div className="mb-3 text-ui-caption text-foreground-subtle">快照时间 {snapshot.generatedAt.replace('T', ' ').slice(0, 19)}</div>
          <div className="mb-6 grid grid-cols-3 gap-4">
            <div className="rounded-xl border border-card-border bg-card p-4">
              <div className="text-ui-xs text-foreground-subtle">开放告警</div>
              <div className={`mt-1 text-ui-xl font-semibold ${snapshot.openAlerts.length > 0 ? 'text-warning' : ''}`}>{snapshot.openAlerts.length}</div>
            </div>
            <div className="rounded-xl border border-card-border bg-card p-4">
              <div className="text-ui-xs text-foreground-subtle">待审批行动</div>
              <div className={`mt-1 text-ui-xl font-semibold ${snapshot.pendingActions.length > 0 ? 'text-warning' : ''}`}>{snapshot.pendingActions.length}</div>
            </div>
            <div className="rounded-xl border border-card-border bg-card p-4">
              <div className="text-ui-xs text-foreground-subtle">资产总数</div>
              <div className="mt-1 text-ui-xl font-semibold">{snapshot.assetHealth.length}</div>
            </div>
          </div>

          {snapshot.pendingActions.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-2 text-ui-base font-medium text-warning">待审批（{snapshot.pendingActions.length}）</h2>
              {snapshot.pendingActions.map((a) => (
                <div key={a.id} className="mb-2 rounded-lg border border-card-border bg-card p-3">
                  <span className={`mr-2 rounded-md px-1.5 py-0.5 text-ui-xs ${a.riskLevel === 'high' ? 'bg-destructive text-destructive-foreground' : 'bg-warning text-warning-foreground'}`}>{a.riskLevel}</span>
                  <span className="text-ui-caption text-foreground-subtle">{a.actorType}</span>
                  <div className="mt-1 break-all font-mono text-ui-sm">{a.command}</div>
                </div>
              ))}
            </div>
          )}

          <h2 className="mb-2 text-ui-base font-medium">开放告警</h2>
          {snapshot.openAlerts.length === 0 ? (
            <div className="mb-6 text-ui-caption text-foreground-subtle">无</div>
          ) : (
            <ul className="mb-6">
              {snapshot.openAlerts.map((a) => (
                <li key={a.id} className="mb-2 rounded-lg border border-card-border bg-card p-3">
                  <span className={`mr-2 text-ui-sm font-medium ${a.severity === 'critical' ? 'text-destructive' : 'text-warning'}`}>{a.severity}</span>
                  <span className="font-mono text-ui-sm">{a.event}</span>
                  <span className="ml-2 text-ui-caption text-foreground-subtle">{a.resource}</span>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mb-2 text-ui-base font-medium">资产健康</h2>
          <div className="flex flex-wrap gap-2">
            {snapshot.assetHealth.map((a) => (
              <span key={a.name} className={`rounded-lg border px-3 py-1 text-ui-sm ${a.status === 'healthy' ? 'border-positive/40 text-positive' : a.status === 'down' ? 'border-destructive/40 text-destructive' : 'border-card-border text-foreground-subtle'}`}>
                {a.name} · {a.status}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
