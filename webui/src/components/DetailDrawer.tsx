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

interface ExecutionDetail {
  ok: boolean; stdout: string; stderr: string; exitCode: number | null;
  timedOut: boolean; durationMs: number; attempts: number; error: string | null;
}
interface EventItem { id: number; event: string; actorType: string; actorId: string; detail: string | null; createdAt: string }

const EVENT_LABEL: Record<string, string> = {
  created: '创建', 'auto-approved': '低危自动放行', approved: '批准', 'direct-run': '直接执行',
  rejected: '否决', cancelled: '取消', expired: '过期', 'exec-started': '开始执行',
  'exec-finished': '执行完成', 'zombie-reconciled': '僵尸对账',
};

export function DetailDrawer({ action, userRole, onClose, onMutated }: DetailDrawerProps) {
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [execution, setExecution] = useState<ExecutionDetail | undefined>(undefined);
  const [events, setEvents] = useState<readonly EventItem[]>([]);
  const approver = userRole !== undefined && can(userRole as never, 'action:approve');

  // 详情完整视图：执行结果 + 事件时间线（列表对象只有状态，输出要单独拉）
  useEffect(() => {
    setExecution(undefined);
    setEvents([]);
    void (async () => {
      try {
        const res = await fetch(`/api/v1/actions/${encodeURIComponent(action.id)}`, { credentials: 'include' });
        if (!res.ok) return;
        const body = (await res.json()) as { execution?: ExecutionDetail; events?: EventItem[] };
        setExecution(body.execution);
        setEvents(body.events ?? []);
      } catch { /* 静默：详情失败不阻塞审批 */ }
    })();
  }, [action.id, action.status]);

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

      {execution !== undefined ? (
        <section aria-label="执行结果" className="rounded-lg border border-card-border bg-surface p-3">
          <div className="mb-2 flex items-center gap-2 text-ui-xs text-foreground-subtle">
            <span className={execution.ok ? 'text-positive' : 'text-destructive'}>{execution.ok ? '● 成功' : '● 失败'}</span>
            <span>退出码 {execution.exitCode ?? '—'}</span>
            <span>耗时 {execution.durationMs}ms</span>
            <span>尝试 {execution.attempts} 次</span>
            {execution.timedOut ? <span className="text-warning">超时击杀</span> : null}
          </div>
          {execution.stdout !== '' ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background-alt p-2 font-mono text-ui-xs">{execution.stdout}</pre>
          ) : null}
          {execution.stderr !== '' ? (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background-alt p-2 font-mono text-ui-xs text-destructive">{execution.stderr}</pre>
          ) : null}
          {execution.error !== null && execution.error !== '' ? (
            <p className="mt-1 text-ui-xs text-destructive">{execution.error}</p>
          ) : null}
          {execution.stdout === '' && execution.stderr === '' && execution.error === null ? (
            <p className="text-ui-xs text-foreground-subtlest">（无输出）</p>
          ) : null}
        </section>
      ) : action.status === 'success' || action.status === 'failed' ? (
        <p className="text-ui-caption text-foreground-subtlest">执行结果加载中…</p>
      ) : null}

      {events.length > 0 ? (
        <section aria-label="事件时间线" className="rounded-lg border border-card-border bg-surface p-3">
          <h3 className="mb-2 text-ui-xs font-medium text-foreground-subtle">治理时间线</h3>
          <ol className="space-y-1">
            {events.map((e) => (
              <li key={e.id} className="flex items-baseline gap-2 text-ui-xs">
                <span className="shrink-0 font-mono text-foreground-subtlest">{e.createdAt.slice(11, 19)}</span>
                <span className="shrink-0 font-medium">{EVENT_LABEL[e.event] ?? e.event}</span>
                <span className="truncate text-foreground-subtle">{e.actorType}:{e.actorId}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

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
