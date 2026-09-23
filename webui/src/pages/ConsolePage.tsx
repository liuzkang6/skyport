/**
 * Agent 操作台（PRD v0.7）：对话式 AI 协作界面 + 态势包展示 + 内联审批卡片。
 * 值班人在一个页面里看 AI 干活、追问、批准——全程不换页。
 */
import { useCallback, useEffect, useState } from 'react';

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

  const loadPack = useCallback(async (name: string) => {
    if (name.trim() === '') return;
    try {
      const res = await fetch(`/api/v1/context/${encodeURIComponent(name)}`, { credentials: 'include' });
      if (!res.ok) { setError(`态势包加载失败: ${res.status}`); return; }
      setPack((await res.json()) as ContextPack);
      setError(undefined);
    } catch { setError('网络不可达'); }
  }, []);

  const loadPending = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/actions?status=pending', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { actions: PendingAction[] };
      setPending(data.actions);
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => { void loadPending(); }, [loadPending]);

  const approve = async (id: string) => {
    setActionNotice(undefined);
    try {
      const res = await fetch(`/api/v1/actions/${id}/approve`, { method: 'POST', credentials: 'include' });
      if (res.ok) { setActionNotice(`✓ ${id} 已批准并执行`); void loadPending(); }
      else { const body = (await res.json().catch(() => ({}))) as { error?: string }; setActionNotice(`✕ ${id}: ${body.error ?? res.statusText}`); }
    } catch { setActionNotice('✕ 网络不可达'); }
  };

  const reject = async (id: string) => {
    setActionNotice(undefined);
    try {
      const res = await fetch(`/api/v1/actions/${id}/reject`, { method: 'POST', credentials: 'include' });
      if (res.ok) { setActionNotice(`已否决 ${id}`); void loadPending(); }
    } catch { setActionNotice('✕ 网络不可达'); }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="mb-4 text-ui-lg font-semibold">Agent 操作台</h1>

      {/* 资产选择 */}
      <div className="mb-4 flex gap-2">
        <input
          value={assetName}
          onChange={(e) => setAssetName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void loadPack(assetName); }}
          placeholder="输入资产名查看态势包…"
          className="flex-1 rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-base text-foreground placeholder:text-foreground-subtlest"
        />
        <button
          onClick={() => void loadPack(assetName)}
          className="rounded-lg bg-primary px-4 py-1.5 text-ui-base text-primary-foreground"
        >查询</button>
      </div>

      {error !== undefined && <div className="mb-4 text-ui-base text-destructive">{error}</div>}
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
                      <span className={a.severity === 'critical' ? 'text-destructive' : 'text-warning'}>{a.severity}</span>
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
