/**
 * Agent 操作台（PRD v0.7）：对话式 AI 协作界面 + 态势包展示 + 内联审批卡片。
 * 值班人在一个页面里看 AI 干活、追问、批准——全程不换页。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { formatShort } from '../lib/time';

interface ContextPack {
  asset: { name: string; type: string; addr: string | null; status: string; labels: Record<string, string>;
    lastCheckAt: string | null; lastCheckLatencyMs: number | null };
  checks: { ok: boolean; latencyMs: number | undefined; error: string | undefined; checkedAt: string }[];
  openAlerts: { id: string; event: string; severity: string; status: string; text: string | undefined }[];
  recentActions: { id: string; command: string; status: string; actor: string; createdAt: string }[];
  blastRadius: { services: string[]; upstream: string[]; downstream: string[] };
  services: string[];
  assembledAt: string;
}

interface PendingAction {
  id: string; command: string; status: string; riskLevel: string; reason: string | undefined;
  rollback: string | undefined; actorType: string; actorName: string | undefined; createdAt: string;
}

export function ConsolePage() {
  const [assetName, setAssetName] = useState('');
  const [pack, setPack] = useState<ContextPack | undefined>(undefined);
  const [pending, setPending] = useState<readonly PendingAction[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState('');
  const [actionNotice, setActionNotice] = useState<string | undefined>(undefined);
  const [packLoading, setPackLoading] = useState(false);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadPack = useCallback(async (name: string) => {
    // QA #14：空输入此前静默无反应
    if (name.trim() === '') { setError('请输入资产名再查询'); return; }
    setPackLoading(true);
    try {
      setPack((await api.context(name.trim())) as unknown as ContextPack);
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '态势包加载失败');
    } finally {
      setPackLoading(false);
    }
  }, []);

  const loadPending = useCallback(async () => {
    try {
      const page = await api.listActions({ status: 'pending' });
      setPending(page.actions);
    } catch { /* 静默：轮询失败不打扰 */ }
  }, []);

  // QA #14：待审批列表随轮询刷新（8s，与看板同节奏），新 pending 不再漏
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await loadPending();
      if (!cancelled) pendingTimer.current = setTimeout(tick, 8_000);
    };
    void tick();
    return () => { cancelled = true; if (pendingTimer.current !== undefined) clearTimeout(pendingTimer.current); };
  }, [loadPending]);

  const approve = async (id: string) => {
    setActionNotice(undefined);
    try {
      await api.approve(id);
      setActionNotice(`✓ ${id} 已批准并执行`);
      void loadPending();
    } catch (e) {
      setActionNotice(`✕ ${id}: ${e instanceof ApiError ? e.message : '操作失败'}`);
    }
  };

  const reject = async (id: string) => {
    setActionNotice(undefined);
    try {
      await api.reject(id);
      setActionNotice(`已否决 ${id}`);
      void loadPending();
    } catch (e) {
      setActionNotice(`✕ ${id}: ${e instanceof ApiError ? e.message : '操作失败'}`);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="mb-4 text-ui-lg font-semibold">Agent 操作台</h1>

      {/* AI 巡查座位（spec/llm-seat）：状态 + 手动巡查 */}
      <PatrollerCard />

      {/* 资产选择 */}
      <div className="mb-4 flex gap-2">
        <input
          value={assetName}
          onChange={(e) => setAssetName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void loadPack(assetName); }}
          aria-label="资产名"
          placeholder="输入资产名查看态势包…"
          className="flex-1 rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-base text-foreground placeholder:text-foreground-subtlest"
        />
        <button
          onClick={() => void loadPack(assetName)}
          className="rounded-lg bg-primary px-4 py-1.5 text-ui-base text-primary-foreground"
        >查询</button>
      </div>

      {error !== undefined && <div className="mb-4 text-ui-base text-destructive">{error}</div>}
      {packLoading && <div className="mb-4 text-ui-caption text-foreground-subtle">态势包加载中…</div>}
      {actionNotice !== undefined && <div className="mb-4 text-ui-base text-foreground">{actionNotice}</div>}

      <div className="flex gap-4">
        {/* 左侧：态势包 + 待审批 */}
        <div className="min-w-0 flex-1 space-y-4">
          {/* 态势包 */}
          {pack !== undefined && (
            <div className="rounded-xl border border-card-border bg-card p-4">
              <h2 className="mb-3 text-ui-base font-medium">态势包 · {pack.asset.name}</h2>
              <div className="grid grid-cols-2 gap-2 text-ui-sm">
                <div><span className="text-foreground-subtle">类型：</span>{pack.asset.type}</div>
                <div><span className="text-foreground-subtle">地址：</span><span className="font-mono">{pack.asset.addr ?? '—'}</span></div>
                <div><span className="text-foreground-subtle">状态：</span>{pack.asset.status}</div>
                <div><span className="text-foreground-subtle">延迟：</span>{pack.asset.lastCheckLatencyMs ?? '—'}ms</div>
              </div>

              {pack.openAlerts.length > 0 && (
                <div className="mt-3">
                  <div className="text-ui-xs text-foreground-subtle">开放告警</div>
                  {pack.openAlerts.map((a) => (
                    <div key={a.id} className="mt-1 flex items-center gap-2 text-ui-sm">
                      <span className={a.severity === 'critical' ? 'text-destructive' : a.severity === 'warning' ? 'text-warning' : 'text-foreground-subtle'}>{a.severity}</span>
                      <span className="font-mono">{a.event}</span>
                    </div>
                  ))}
                </div>
              )}

              {pack.blastRadius.services.length > 0 && (
                <div className="mt-3 text-ui-sm">
                  <span className="text-foreground-subtle">影响范围：</span>
                  {pack.blastRadius.services.join('、')}
                  {pack.blastRadius.downstream.length > 0 && <span className="text-foreground-subtle">（下游：{pack.blastRadius.downstream.join('、')}）</span>}
                </div>
              )}
            </div>
          )}

          {/* 待审批卡片 */}
          {pending.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-ui-base font-medium">待审批（{pending.length}）</h2>
              {pending.map((a) => (
                <div key={a.id} className={`rounded-xl border p-4 ${a.riskLevel === 'high' ? 'border-destructive bg-card' : 'border-card-border bg-card'}`}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className={`rounded-md px-1.5 py-0.5 text-ui-xs ${
                      a.riskLevel === 'high' ? 'bg-destructive text-destructive-foreground'
                      : a.riskLevel === 'medium' ? 'bg-warning text-warning-foreground' : 'bg-tag text-foreground'
                    }`}>{a.riskLevel}</span>
                    <span className="text-ui-caption text-foreground-subtle">{a.actorType}:{a.actorName ?? a.id}</span>
                  </div>
                  <div className="mb-2 break-all font-mono text-ui-sm">{a.command}</div>
                  {a.reason !== undefined && <div className="mb-1 text-ui-caption text-foreground-subtle">理由：{a.reason}</div>}
                  {a.rollback !== undefined && <div className="mb-1 text-ui-caption text-foreground-subtle">回滚：{a.rollback}</div>}
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => void approve(a.id)} className="rounded-lg bg-primary px-4 py-1.5 text-ui-sm text-primary-foreground">批准执行</button>
                    <button onClick={() => void reject(a.id)} className="rounded-lg px-4 py-1.5 text-ui-sm text-foreground hover:bg-hover">拒绝</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右侧：消息输入（预留 AI 对话） */}
        <div className="w-72 shrink-0 rounded-xl border border-card-border bg-card p-4">
          <h3 className="mb-2 text-ui-sm font-medium">发送指令</h3>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="给处置员发消息…（v0.5 运行时接入后生效）"
            className="mb-2 h-24 w-full resize-none rounded-lg border border-input-border bg-input px-3 py-2 text-ui-sm text-foreground placeholder:text-foreground-subtlest"
          />
          <button className="w-full rounded-lg bg-secondary px-3 py-1.5 text-ui-sm text-foreground" disabled>发送（待运行时接入）</button>
        </div>
      </div>
    </div>
  );
}

interface SweepResult {
  runId: string; completedAt: string; modelsUsed: string; promptTokens: number; completionTokens: number;
  anomalies: string[]; proposals: { command: string; target: string; reason: string; actionId: string; status: string }[]; note: string;
}

/** AI 巡查卡片：最近巡查状态 + 手动触发（低危只读提案自动执行，中高危走审批） */
function PatrollerCard() {
  const [last, setLast] = useState<SweepResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      try {
        const body = (await api.patrollerStatus()) as { lastSweep: SweepResult | null };
        setLast(body.lastSweep);
      } catch { /* 静默 */ }
    })();
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(undefined);
    try {
      setLast((await api.patrollerRun()) as unknown as SweepResult);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '巡查失败');
    } finally { setRunning(false); }
  }, []);

  return (
    <div className="mb-4 rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="text-ui-base font-medium">AI 巡查员</span>
        <span className="rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">每 15 分钟自动巡逻</span>
        {last !== null && <span className="text-ui-caption text-foreground-subtle">最近：{formatShort(last.completedAt)} · {last.modelsUsed}</span>}
        <button
          type="button"
          disabled={running}
          onClick={() => void run()}
          className="ml-auto rounded-lg bg-primary px-3 py-1 text-ui-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >{running ? '巡查中…' : '立即巡查'}</button>
      </div>
      {error !== undefined && <div className="mt-2 text-ui-sm text-destructive">{error}</div>}
      {last !== null && (
        <div className="mt-2 text-ui-sm">
          <span className="text-foreground-subtle">{last.note}</span>
          {last.anomalies.length > 0 && <span className="ml-2 rounded-md bg-warning/20 px-1.5 py-0.5 text-ui-xs text-warning">异常 {last.anomalies.length}</span>}
          {last.proposals.map((p) => (
            <div key={p.actionId} className="mt-1 rounded-lg bg-surface p-2">
              <span className={`mr-2 rounded-md px-1.5 py-0.5 text-ui-xs ${p.status === 'success' ? 'bg-success text-success-foreground' : p.status === 'pending' ? 'bg-warning text-warning-foreground' : 'bg-destructive text-destructive-foreground'}`}>{p.status}</span>
              <span className="font-mono text-ui-xs">{p.target}$ {p.command}</span>
              <span className="ml-2 text-ui-caption text-foreground-subtle">{p.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
