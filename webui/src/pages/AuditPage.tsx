/**
 * 审计页（PRD v0.7）：行动台账（分页，QA #3：此前静默截断 50 条）+ 状态过滤
 * + 事件流回放（行可键盘达，QA #10）+ 哈希链校验。数据访问统一走 api/client（QA #13）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ApiAction } from '../api/types';
import { formatDateTime, formatClock } from '../lib/time';

interface AuditEvent {
  id: number; event: string; actorType: string; actorId: string; detail: string | undefined; createdAt: string;
}

const STATUS_OPTIONS = ['', 'pending', 'approved', 'executing', 'success', 'failed', 'rejected', 'cancelled'];
const PAGE_SIZE = 50;

export function AuditPage() {
  const [actions, setActions] = useState<readonly ApiAction[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<ApiAction | undefined>(undefined);
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [chainOk, setChainOk] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    try {
      const page = await api.listActions({ status: statusFilter === '' ? undefined : statusFilter, limit: PAGE_SIZE, offset });
      setActions((prev) => (append ? [...prev, ...page.actions] : page.actions));
      setTotal(page.total);
      setHasMore(page.hasMore);
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  const verifyChain = useCallback(async () => {
    try {
      const data = await api.auditVerify();
      setChainOk(data.ok);
    } catch { setChainOk(false); }
  }, []);

  const loadEvents = useCallback(async (id: string) => {
    try {
      const detail = await api.getActionDetail(id);
      setSelected(detail.action);
      setEvents((detail.events ?? []) as readonly AuditEvent[]);
    } catch { /* 静默：回放失败不影响台账 */ }
  }, []);

  useEffect(() => { void load(0, false); void verifyChain(); }, [load, verifyChain]);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-4">
        <h1 className="text-ui-lg font-semibold">审计</h1>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="按状态过滤"
          className="rounded-lg border border-input-border bg-input px-2 py-1 text-ui-sm text-foreground"
        >
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s === '' ? '全部状态' : s}</option>)}
        </select>
        {chainOk !== undefined && (
          <span className={`text-ui-sm ${chainOk ? 'text-success' : 'text-destructive'}`}>
            {chainOk ? '✓ 审计链完整' : '✕ 审计链断裂'}
          </span>
        )}
        <span className="ml-auto text-ui-caption text-foreground-subtle">
          共 {total} 条{actions.length < total ? `，已显示 ${actions.length} 条` : ''}
        </span>
      </div>

      {error !== undefined && <div className="mb-3 text-ui-base text-destructive">{error}</div>}

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
                  tabIndex={0}
                  role="button"
                  aria-label={`查看行动 ${a.id} 事件流`}
                  onClick={() => void loadEvents(a.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void loadEvents(a.id); } }}
                  className={`cursor-pointer border-b border-card-border last:border-0 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground-subtle ${selected?.id === a.id ? 'bg-selected' : ''}`}
                >
                  <td className="px-3 py-2 font-mono">{a.id}</td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono">{a.command}</td>
                  <td className={`px-3 py-2 ${a.status === 'success' ? 'text-success' : a.status === 'failed' ? 'text-destructive' : 'text-foreground-subtle'}`}>{a.status}</td>
                  <td className="px-3 py-2">{a.riskLevel}</td>
                  <td className="px-3 py-2">{a.actorType}:{a.actorName ?? '—'}</td>
                  <td className="px-3 py-2 text-foreground-subtle">{formatDateTime(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && actions.length === 0 && <div className="mt-4 text-ui-caption text-foreground-subtle">暂无记录</div>}
          {loading && <div className="mt-4 text-ui-caption text-foreground-subtle">加载中…</div>}
          {hasMore && !loading ? (
            <button
              type="button"
              onClick={() => void load(actions.length, true)}
              className="mt-3 rounded-lg border border-input-border px-3 py-1 text-ui-sm hover:bg-hover"
            >
              加载更多（还有 {total - actions.length} 条）
            </button>
          ) : null}
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
                  <span className="text-ui-xs text-foreground-subtlest">{formatClock(e.createdAt)}</span>
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
