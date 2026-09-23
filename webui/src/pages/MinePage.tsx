/**
 * 我的页（PRD v0.7 Linear 式导航）：我创建的行动时间线——状态徽章 + 命令 + 时间。
 * 数据源 GET /api/v1/actions?actor=<用户名>（红队 U5：human 用户名可过滤）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useApp } from '../store/app';
import type { ApiAction } from '../api/types';
import { formatDateTime } from '../lib/time';


const STATUS_LABEL: Record<string, string> = {
  pending: '待审批', approved: '已放行', executing: '执行中', success: '成功', failed: '失败', rejected: '已否决', cancelled: '已取消', expired: '已过期',
};

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-warning text-warning-foreground',
  executing: 'bg-warning text-warning-foreground',
  success: 'bg-success text-success-foreground',
  failed: 'bg-destructive text-destructive-foreground',
  rejected: 'bg-destructive text-destructive-foreground',
};

export function MinePage() {
  const user = useApp((s) => s.user);
  const [mine, setMine] = useState<readonly ApiAction[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (user === undefined) return;
    try {
      const page = await api.listActions({ actor: user.name, limit: 100 });
      setMine(page.actions);
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  if (error !== undefined) return <div className="p-6 text-ui-base text-destructive">{error}</div>;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="mb-1 text-ui-lg font-semibold">我的</h1>
      <p className="mb-4 text-ui-caption text-foreground-subtle">{user?.name} 创建的行动（{mine.length}）</p>
      {mine.length === 0 ? (
        <div className="text-ui-caption text-foreground-subtle">还没有创建过行动</div>
      ) : (
        <ul>
          {mine.map((a) => (
            <li key={a.id} className="mb-2 rounded-lg border border-card-border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className={`rounded-md px-1.5 py-0.5 text-ui-xs ${STATUS_STYLE[a.status] ?? 'bg-surface text-foreground-subtle'}`}>
                  {STATUS_LABEL[a.status] ?? a.status}
                </span>
                <span className={`rounded-md px-1.5 py-0.5 text-ui-xs ${a.riskLevel === 'high' ? 'bg-destructive text-destructive-foreground' : a.riskLevel === 'medium' ? 'bg-warning text-warning-foreground' : 'bg-surface text-foreground-subtle'}`}>
                  {a.riskLevel}
                </span>
                <span className="text-ui-caption text-foreground-subtle">{a.targetName}</span>
                <span className="ml-auto shrink-0 text-ui-caption text-foreground-subtlest">{formatDateTime(a.createdAt)}</span>
              </div>
              <div className="mt-1 break-all font-mono text-ui-sm">{a.command}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
