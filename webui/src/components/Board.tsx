/**
 * 行动看板（spec/webui 产品规则核心）：七列固定 = 治理状态机；拖拽 = 受约束迁移。
 * 拖 pending 卡到 approved/rejected 列 → 批准/否决（approver+，服务端复核）；
 * 其他落点一律回弹并提示状态机约束。
 */
import { useCallback, useState, type DragEvent } from 'react';
import { useApp } from '../store/app';
import { api, ApiError } from '../api/client';
import type { ApiAction } from '../api/types';
import { BOARD_COLUMNS, can, transitionIntent, type ActionStatus } from '../lib/governance';
import { ActionCard } from './ActionCard';

interface BoardProps {
  readonly onOpenDetail: (action: ApiAction) => void;
}

export function Board({ onOpenDetail }: BoardProps) {
  const actions = useApp((s) => s.actions);
  const boardHasMore = useApp((s) => s.boardHasMore);
  const refreshBoard = useApp((s) => s.refreshBoard);
  const user = useApp((s) => s.user);
  const [dragId, setDragId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const approver = user !== undefined && can(user.role, 'action:approve');

  const onDragStart = useCallback((action: ApiAction, event: DragEvent<HTMLElement>) => {
    setDragId(action.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', action.id);
  }, []);

  const runTransition = useCallback(
    async (action: ApiAction, intent: { kind: 'approve' } | { kind: 'reject' }, note?: string) => {
      if (!approver) {
        setNotice('角色无审批权（需要 approver 或 admin）');
        return;
      }
      setBusy(true);
      try {
        if (intent.kind === 'approve') {
          await api.approve(action.id);
        } else {
          await api.reject(action.id, note);
        }
        setNotice(intent.kind === 'approve' ? `已批准：${action.id}` : `已否决：${action.id}`);
        await refreshBoard();
      } catch (error) {
        setNotice(error instanceof ApiError ? error.message : '操作失败');
      } finally {
        setBusy(false);
      }
    },
    [approver, refreshBoard],
  );

  const onDropColumn = useCallback(
    (to: ActionStatus) => (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const id = dragId ?? event.dataTransfer.getData('text/plain');
      setDragId(undefined);
      const action = actions.find((a) => a.id === id);
      if (action === undefined) return;
      const intent = transitionIntent(action.status, to);
      if (intent === null) {
        setNotice(`状态机约束：${action.status} 不能直接迁到 ${to}（仅 pending 可批准/否决）`);
        return;
      }
      void runTransition(action, intent);
    },
    [actions, dragId, runTransition],
  );

  return (
    <section aria-label="行动看板" className="flex min-h-0 flex-1 flex-col">
      {/* QA #3：看板 limit=200，超出部分静默丢弃——显式告知 */}
      {boardHasMore ? (
        <p className="mb-1 text-ui-xs text-foreground-subtlest">数据较多，仅显示最近 200 条（完整台账见审计页）</p>
      ) : null}
      {notice !== undefined ? (
        <div
          role="status"
          className="mb-2 flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-caption"
        >
          <span className="min-w-0 truncate">{notice}</span>
          <button type="button" className="ml-2 shrink-0 text-foreground-subtle hover:text-foreground" onClick={() => setNotice(undefined)}>
            关闭
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {BOARD_COLUMNS.map(({ status, symbol, label }) => {
          const column = actions.filter((a) => a.status === status);
          // QA #11：所有列都注册 drop——非法落点由 transitionIntent 判定并走 notice 提示，
          // 不再因未注册 handler 被浏览器静默取消；仅 pending 卡可拖且需审批权
          const isDropTarget = approver;
          return (
            <div
              key={status}
              className="flex w-72 shrink-0 flex-col rounded-xl border border-card-border/60 bg-background-alt"
              onDragOver={isDropTarget ? (event) => event.preventDefault() : undefined}
              onDrop={isDropTarget ? onDropColumn(status) : undefined}
              aria-label={`${label}列，${column.length}条`}
            >
              <header className="flex items-center gap-2 px-3 pb-2 pt-3">
                <span aria-hidden className="text-ui-caption text-foreground-subtle">{symbol}</span>
                <h2 className="text-ui-caption font-medium text-foreground-subtle">{label}</h2>
                <span className="ml-auto rounded-full bg-surface px-2 py-0.5 font-mono text-ui-xs text-foreground-subtle">{column.length}</span>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {column.map((action) => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    draggable={!busy && approver && action.status === 'pending'}
                    onOpen={onOpenDetail}
                    onDragStart={onDragStart}
                  />
                ))}
                {column.length === 0 ? (
                  <p className="px-2 py-3 text-ui-xs text-foreground-subtlest">（空）</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
