/**
 * 事件页（PRD v0.7）：告警流 + 事件详情（关联组/态势包/AI 诊断时间线）。
 */
import { useCallback, useEffect, useState } from 'react';

interface Alert {
  id: string; event: string; resource: string; severity: string; status: string;
  value: string | null; text: string | null; tags: string[]; origin: string;
  timestamp: string;
}

const SEV_COLOR: Record<string, string> = { critical: 'text-destructive', warning: 'text-warning', info: 'text-foreground-subtle' };

export function IncidentsPage() {
  const [alerts, setAlerts] = useState<readonly Alert[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const url = statusFilter === '' ? '/api/v1/alerts' : `/api/v1/alerts?status=${statusFilter}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) { setError(`加载失败: ${res.status}`); return; }
      setAlerts(((await res.json()) as { alerts: Alert[] }).alerts);
      setError(undefined);
    } catch { setError('网络不可达'); }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  if (error !== undefined) return <div className="p-6 text-ui-base text-destructive">{error}</div>;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-4">
        <h1 className="text-ui-lg font-semibold">事件</h1>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-input-border bg-input px-2 py-1 text-ui-sm"
        >
          <option value="">全部</option>
          <option value="open">开放</option>
          <option value="ack">已确认</option>
          <option value="closed">已关闭</option>
        </select>
      </div>

      {alerts.length === 0 ? (
        <div className="text-ui-caption text-foreground-subtle">暂无事件</div>
      ) : (
        <table className="w-full rounded-lg border border-card-border bg-card text-ui-sm">
          <thead>
            <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
              <th className="px-3 py-2 text-left">严重级</th>
              <th className="px-3 py-2 text-left">事件</th>
              <th className="px-3 py-2 text-left">资源</th>
              <th className="px-3 py-2 text-left">状态</th>
              <th className="px-3 py-2 text-left">来源</th>
              <th className="px-3 py-2 text-left">时间</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id} className="border-b border-card-border last:border-0">
                <td className={`px-3 py-2 font-medium ${SEV_COLOR[a.severity] ?? ''}`}>{a.severity}</td>
                <td className="px-3 py-2 font-mono">{a.event}</td>
                <td className="px-3 py-2 font-mono">{a.resource}</td>
                <td className="px-3 py-2">{a.status}</td>
                <td className="px-3 py-2 text-foreground-subtle">{a.origin}</td>
                <td className="px-3 py-2 text-foreground-subtle">{a.timestamp.slice(5, 16).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
