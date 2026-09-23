/**
 * 行动卡片（spec：审批决策要素一眼可读）：风险徽章 + 发起者 + 目标 + 命令（mono，截断必提示）。
 * 仅 pending 卡可拖（受约束迁移）；键盘用户经抽屉按钮完成同等操作（§8 键盘一等公民）。
 */
import type { DragEvent } from 'react';
import type { ApiAction } from '../api/types';
import { RiskBadge, StatusBadge } from './GovBadge';
import { actorDisplay, truncateCommand } from '../lib/governance';
import { formatClock } from '../lib/time';

interface ActionCardProps {
  readonly action: ApiAction;
  readonly draggable: boolean;
  readonly onOpen: (action: ApiAction) => void;
  readonly onDragStart: (action: ApiAction, event: DragEvent<HTMLElement>) => void;
}

export function ActionCard({ action, draggable, onOpen, onDragStart }: ActionCardProps) {
  const command = truncateCommand(action.command);
  const actor = actorDisplay(action.actorType, action.actorName, action.actorId);
  const time = formatClock(action.createdAt);

  // 左缘风险色条（pending 可拖卡强化风险预读；DESIGN.md 治理色域）
  const riskEdge =
    action.riskLevel === 'high' ? 'border-l-gov-risk-high'
    : action.riskLevel === 'medium' ? 'border-l-gov-risk-medium'
    : action.riskLevel === 'low' ? 'border-l-gov-risk-low' : '';

  return (
    <article
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={(event) => onDragStart(action, event)}
      onClick={() => onOpen(action)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(action);
        }
      }}
      className={`w-full cursor-pointer rounded-lg border border-card-border border-l-2 ${riskEdge} bg-card p-2.5 transition-colors hover:border-border-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground-subtle`}
      aria-label={`行动 ${action.id}：${action.status}，目标 ${action.targetName}`}
    >
      <header className="flex min-w-0 items-center justify-between gap-2">
        <RiskBadge level={action.riskLevel} />
        <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">{time}</span>
      </header>
      <p className="mt-2 truncate font-mono text-ui-sm text-foreground" title={action.command}>
        {command.text}
        {command.truncated ? <span className="text-foreground-subtlest">（详情看全文）</span> : null}
      </p>
      <footer className="mt-2 flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-ui-xs text-foreground-subtle">
          <span className="font-mono">{action.targetName}</span>
          <span className="mx-1 text-foreground-subtlest">·</span>
          {actor}
        </span>
        <StatusBadge status={action.status} />
      </footer>
    </article>
  );
}
