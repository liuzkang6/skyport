/**
 * 收件箱页（PRD v0.7）：需要我处理的更新——审批/ACK/升级/告警通知。
 */
import { useCallback, useEffect, useState } from 'react';

interface Alert { id: string; event: string; resource: string; severity: string; status: string; text: string | undefined; timestamp: string }
interface PendingAction { id: string; command: string; riskLevel: string; actorType: string; actorName: string | undefined; reason: string | undefined; createdAt: string }

export function InboxPage() {
  const [alerts, setAlerts] = useState<readonly Alert[]>([]);
  const [pending, setPending] = useState<readonly PendingAction[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [alertRes, actionRes] = await Promise.all([
        fetch('/api/v1/alerts?status=open', { credentials: 'include' }),
        fetch('/api/v1/actions?status=pending', { credentials: 'include' }),
      ]);
      if (alertRes.ok) setAlerts(((await alertRes.json()) as { alerts: Alert[] }).alerts);
      if (actionRes.ok) setPending(((await actionRes.json()) as { actions: PendingAction[] }).actions);
      setError(undefined);
    } catch { setError('网络不可达'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error !== undefined) return <div className="p-6 text-ui-base text-destructive">{error}</div>;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="mb-4 text-ui-lg font-semibold">收件箱</h1>

      {pending.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-ui-base font-medium text-warning">待审批（{pending.length}）</h2>
          {pending.map((a) => (
            <div key={a.id} className="mb-2 rounded-lg border border-card-border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className={`rounded-md px-1.5 py-0.5 text-ui-xs ${a.riskLevel === 'high' ? 'bg-destructive text-destructive-foreground' : 'bg-warning text-warning-foreground'}`}>{a.riskLevel}</span>
                <span className="text-ui-caption text-foreground-subtle">{a.actorType}:{a.actorName ?? '—'}</span>
              </div>
              <div className="mt-1 break-all font-mono text-ui-sm">{a.command}</div>
              {a.reason !== undefined && <div className="text-ui-caption text-foreground-subtle">理由：{a.reason}</div>}
            </div>
          ))}
        </div>
      )}

      <div>
        <h2 className="mb-2 text-ui-base font-medium">开放告警（{alerts.length}）</h2>
        {alerts.length === 0 ? (
          <div className="text-ui-caption text-foreground-subtle">暂无开放告警</div>
        ) : (
          alerts.map((a) => (
            <div key={a.id} className="mb-2 rounded-lg border border-card-border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className={`text-ui-sm ${a.severity === 'critical' ? 'text-destructive' : 'text-warning'}`}>{a.severity}</span>
                <span className="font-mono text-ui-sm">{a.event}</span>
                <span className="text-ui-caption text-foreground-subtle">{a.resource}</span>
              </div>
              {a.text !== undefined && <div className="mt-1 text-ui-sm text-foreground-subtle">{a.text}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
