/**
 * 审计页（PRD v0.7）：全量行动台账 + 状态过滤 + 事件流回放 + 哈希链校验。
 */
import { useCallback, useEffect, useState } from 'react';

interface AuditAction {
  id: string; command: string; status: string; riskLevel: string;
  actorType: string; actorName: string | undefined; reason: string | undefined;
  rollback: string | undefined; createdAt: string;
}

interface AuditEvent {
  id: number; event: string; actorType: string; actorId: string; detail: string | undefined; createdAt: string;
}

const STATUS_OPTIONS = ['', 'pending', 'approved', 'executing', 'success', 'failed', 'rejected', 'cancelled'];

export function AuditPage() {
  const [actions, setActions] = useState<readonly AuditAction[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<AuditAction | undefined>(undefined);
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [chainOk, setChainOk] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const url = statusFilter === '' ? '/api/v1/actions' : `/api/v1/actions?status=${statusFilter}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) { setError(`加载失败: ${res.status}`); return; }
      const data = (await res.json()) as { actions: AuditAction[] };
      setActions(data.actions);
      setError(undefined);
    } catch { setError('网络不可达'); }
  }, [statusFilter]);

  const verifyChain = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/audit/verify', { credentials: 'include' });
      const data = (await res.json()) as { ok: boolean; checked: number };
      setChainOk(data.ok);
    } catch { setChainOk(false); }
  }, []);

  const loadEvents = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/v1/actions/${id}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { action: AuditAction; events: AuditEvent[] };
      setSelected(data.action);
      setEvents(data.events);
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => { void load(); void verifyChain(); }, [load, verifyChain]);

  if (error !== undefined) return <div className="p-6 text-ui-base text-destructive">{error}</div>;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-4">
        <h1 className="text-ui-lg font-semibold">审计</h1>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-input-border bg-input px-2 py-1 text-ui-sm text-foreground"
        >
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s === '' ? '全部状态' : s}</option>)}
        </select>
        {chainOk !== undefined && (
          <span className={`text-ui-sm ${chainOk ? 'text-success' : 'text-destructive'}`}>
            {chainOk ? '✓ 审计链完整' : '✕ 审计链断裂'}
          </span>
        )}
      </div>

      <div className="flex gap-4">
        {/* 行动台账表 */}
        <div className="min-w-0 flex-1">
          <table className="w-full rounded-lg border border-card-border bg-card text-ui-sm">
            <thead>
              <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
                <th className="px-3 py-2 text-left">ID</th>
                <th className="px-3 py-2 text-left">命令</th>
                <th className="px-3 py-2 text-left">状态</th>
                <th className="px-3 py-2 text-left">风险</th>
                <th className="px-3 py-2 text-left">发起者</th>
                <th className="px-3 py-2 text-left">时间</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => void loadEvents(a.id)}
                  className={`cursor-pointer border-b border-card-border last:border-0 hover:bg-hover ${selected?.id === a.id ? 'bg-selected' : ''}`}
                >
                  <td className="px-3 py-2 font-mono">{a.id}</td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono">{a.command}</td>
                  <td className={`px-3 py-2 ${a.status === 'success' ? 'text-success' : a.status === 'failed' ? 'text-destructive' : 'text-foreground-subtle'}`}>{a.status}</td>
                  <td className="px-3 py-2">{a.riskLevel}</td>
                  <td className="px-3 py-2">{a.actorType}:{a.actorName ?? '—'}</td>
                  <td className="px-3 py-2 text-foreground-subtle">{a.createdAt.slice(5, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {actions.length === 0 && <div className="mt-4 text-ui-caption text-foreground-subtle">暂无记录</div>}
        </div>

        {/* 事件流回放 */}
        {selected !== undefined && (
          <div className="w-80 shrink-0 rounded-xl border border-card-border bg-card p-4">
            <div className="mb-3">
              <div className="font-mono text-ui-sm">{selected.id}</div>
              <div className="mt-1 break-all text-ui-caption text-foreground-subtle">{selected.command}</div>
              {selected.rollback !== undefined && <div className="mt-1 text-ui-caption text-foreground-subtle">回滚：{selected.rollback}</div>}
            </div>
            <div className="mb-2 text-ui-xs text-foreground-subtle">事件流</div>
            <div className="space-y-1">
              {events.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-ui-sm">
                  <span className="text-ui-xs text-foreground-subtlest">{e.createdAt.slice(11, 19)}</span>
                  <span className={e.event.includes('approved') || e.event.includes('success') ? 'text-success' : e.event.includes('reject') || e.event.includes('fail') ? 'text-destructive' : 'text-foreground'}>
                    {e.event}
                  </span>
                  <span className="text-ui-xs text-foreground-subtle">{e.actorType}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
