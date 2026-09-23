/**
 * 治理徽章（DESIGN.md 治理色域 + §8 无障碍）：
 * 颜色 + 符号 + 文字三编码；状态与风险两族，禁止语义色漂移借用。
 */
import { Badge } from './ui/Badge';
import type { ActionStatus, RiskLevel } from '../lib/governance';
import { BOARD_COLUMNS, RISK_LABEL } from '../lib/governance';

const STATUS_CLASS: Readonly<Record<ActionStatus, string>> = {
  pending: 'text-gov-pending border-gov-pending/40 bg-gov-pending/10',
  approved: 'text-gov-approved border-gov-approved/40 bg-gov-approved/10',
  executing: 'text-gov-executing border-gov-executing/40 bg-gov-executing/10',
  success: 'text-gov-success border-gov-success/40 bg-gov-success/10',
  failed: 'text-gov-failed border-gov-failed/40 bg-gov-failed/10',
  rejected: 'text-gov-rejected border-gov-rejected/40 bg-gov-rejected/10',
  cancelled: 'text-gov-cancelled border-gov-cancelled/40 bg-gov-cancelled/10',
};

export function StatusBadge({ status }: { status: ActionStatus }) {
  const column = BOARD_COLUMNS.find((c) => c.status === status);
  return (
    <Badge className={`border ${STATUS_CLASS[status]}`}>
      <span aria-hidden>{column?.symbol}</span>
      {column?.label ?? status}
    </Badge>
  );
}

const RISK_CLASS: Readonly<Record<RiskLevel, string>> = {
  low: 'text-gov-risk-low border-gov-risk-low/40 bg-gov-risk-low/10',
  medium: 'text-gov-risk-medium border-gov-risk-medium/40 bg-gov-risk-medium/10',
  high: 'text-gov-risk-high border-gov-risk-high/40 bg-gov-risk-high/10',
};

const RISK_SYMBOL: Readonly<Record<RiskLevel, string>> = {
  low: '·', medium: '▲', high: '▲▲',
};

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <Badge className={`border ${RISK_CLASS[level]}`}>
      <span aria-hidden>{RISK_SYMBOL[level]}</span>
      {RISK_LABEL[level]}
    </Badge>
  );
}
