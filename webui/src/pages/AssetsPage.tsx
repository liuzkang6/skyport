/**
 * 资产列表页（PRD v0.7）：消费 /api/v1/assets，展示类型/地址/状态/标签。
 */
import { useCallback, useEffect, useState } from 'react';

interface Asset {
  id: string; name: string; type: string; addr: string | null;
  labels: Record<string, string>; status: string;
  lastCheckAt: string | null; lastCheckLatencyMs: number | null; lastCheckError: string | null;
}

const STATUS_TEXT: Record<string, string> = { up: '● 正常', down: '✕ 异常', unknown: '○ 未知' };

export function AssetsPage() {
  const [assets, setAssets] = useState<readonly Asset[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [typeFilter, setTypeFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/assets', { credentials: 'include' });
      if (!res.ok) { setError(`加载失败: ${res.status}`); return; }
      const data = (await res.json()) as { assets: Asset[] };
      setAssets(data.assets);
      setError(undefined);
    } catch { setError('网络不可达'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error !== undefined) return <div className="p-6 text-ui-base text-destructive">{error}</div>;

  const filtered = typeFilter === '' ? assets : assets.filter((a) => a.type === typeFilter);
  const types = [...new Set(assets.map((a) => a.type))];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-4">
        <h1 className="text-ui-lg font-semibold">资产</h1>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-lg border border-input-border bg-input px-2 py-1 text-ui-sm text-foreground"
        >
          <option value="">全部类型</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span className="text-ui-caption text-foreground-subtle">共 {filtered.length} 项</span>
      </div>

      {filtered.length === 0 ? (
        <div className="text-ui-caption text-foreground-subtle">暂无资产</div>
      ) : (
        <table className="w-full rounded-lg border border-card-border bg-card text-ui-sm">
          <thead>
            <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
              <th className="px-4 py-2 text-left">名称</th>
              <th className="px-4 py-2 text-left">类型</th>
              <th className="px-4 py-2 text-left">地址</th>
              <th className="px-4 py-2 text-left">状态</th>
              <th className="px-4 py-2 text-left">标签</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id} className="border-b border-card-border last:border-0">
                <td className="px-4 py-2 font-mono">{a.name}</td>
                <td className="px-4 py-2">{a.type}</td>
                <td className="px-4 py-2 font-mono">{a.addr ?? '—'}</td>
                <td className={`px-4 py-2 ${a.status === 'up' ? 'text-success' : a.status === 'down' ? 'text-destructive' : 'text-foreground-subtle'}`}>
                  {STATUS_TEXT[a.status] ?? a.status}
                </td>
                <td className="px-4 py-2">
                  {Object.entries(a.labels).map(([k, v]) => (
                    <span key={k} className="mr-1 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">{k}={v}</span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
