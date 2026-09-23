/**
 * 详情抽屉（spec：就地审批）：命令全文、理由、回滚声明、发起者与时间；
 * 批准/否决按钮仅 approver+ 可见（viewer/operator 只读看板）。
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ApiAction } from '../api/types';
import { can } from '../lib/governance';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { RiskBadge, StatusBadge } from './GovBadge';
import { actorDisplay } from '../lib/governance';

interface DetailDrawerProps {
  readonly action: ApiAction;
  readonly userRole: string | undefined;
  readonly onClose: () => void;
  readonly onMutated: () => Promise<void>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ui-xs text-foreground-subtlest">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-ui-caption text-foreground">{children}</dd>
    </div>
  );
}

export function DetailDrawer({ action, userRole, onClose, onMutated }: DetailDrawerProps) {
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const approver = userRole !== undefined && can(userRole as never, 'action:approve');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function mutate(kind: 'approve' | 'reject') {
    setBusy(true);
    setFeedback(undefined);
    try {
      if (kind === 'approve') {
        await api.approve(action.id);
        setFeedback('已批准');
      } else {
        await api.reject(action.id, note.trim() === '' ? undefined : note.trim());
        setFeedback('已否决');
      }
      await onMutated();
    } catch (error) {
      setFeedback(error instanceof ApiError ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      role="dialog"
      aria-label={`行动详情 ${action.id}`}
      className="flex w-full max-w-md shrink-0 flex-col gap-3 overflow-y-auto rounded-xl border border-card-border bg-card p-4"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={action.status} />
          <RiskBadge level={action.riskLevel} />
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="关闭详情">✕</Button>
      </header>

      <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-3">
        <Row label="命令">
          <code className="block rounded-lg bg-surface p-2 font-mono text-ui-sm">{action.command}</code>
        </Row>
        <Row label="目标">
          <span className="font-mono">{action.targetName}</span>（{action.targetKind}）
        </Row>
        <Row label="发起者">{actorDisplay(action.actorType, action.actorName, action.actorId)}</Row>
        <Row label="理由">{action.reason ?? '（未提供）'}</Row>
        <Row label="回滚">
          {action.rollback === undefined || action.rollback === '' ? (
            <span className="text-destructive">（无回滚声明）</span>
          ) : (
            <code className="block rounded-lg bg-surface p-2 font-mono text-ui-sm">{action.rollback}</code>
          )}
        </Row>
        <Row label="行动 ID">
          <span className="font-mono text-ui-sm">{action.id}</span>
        </Row>
        <Row label="创建">{new Date(action.createdAt).toLocaleString('zh-CN', { hour12: false })}</Row>
      </dl>

      {feedback !== undefined ? (
        <p role="status" className="rounded-lg bg-surface px-3 py-1.5 text-ui-caption">{feedback}</p>
      ) : null}

      {approver && action.status === 'pending' ? (
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="否决备注（可选，随审计留痕）"
            aria-label="否决备注"
          />
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" disabled={busy} onClick={() => void mutate('approve')}>
              批准执行
            </Button>
            <Button variant="destructive" className="flex-1" disabled={busy} onClick={() => void mutate('reject')}>
              否决
            </Button>
          </div>
        </div>
      ) : action.status === 'pending' ? (
        <p className="mt-auto border-t border-border pt-3 text-ui-caption text-foreground-subtle">
          当前角色只读（审批需要 approver/admin）
        </p>
      ) : null}
    </aside>
  );
}
