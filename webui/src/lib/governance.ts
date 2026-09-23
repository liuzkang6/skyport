/**
 * 治理规则纯逻辑（spec/webui）：状态机列序、受约束迁移、角色能力门禁（UI 侧投影）。
 * 权威在后端（services/actions 状态机 + services/users 能力集）；此处仅用于交互 gating 与渲染，
 * 服务端始终复核——前端绕过不构成越权。
 */

export type ActionStatus =
  | 'pending' | 'approved' | 'executing' | 'success' | 'failed' | 'rejected' | 'cancelled';

export type RiskLevel = 'low' | 'medium' | 'high';

export type UserRole = 'viewer' | 'operator' | 'approver' | 'admin';

/** 七列固定顺序（与 CLI render 符号一一对应，DESIGN.md 治理色域） */
export const BOARD_COLUMNS: readonly { status: ActionStatus; symbol: string; label: string }[] = [
  { status: 'pending', symbol: '○', label: '待审批' },
  { status: 'approved', symbol: '◐', label: '已放行' },
  { status: 'executing', symbol: '⟳', label: '执行中' },
  { status: 'success', symbol: '●', label: '成功' },
  { status: 'failed', symbol: '✕', label: '失败' },
  { status: 'rejected', symbol: '⊘', label: '已否决' },
  { status: 'cancelled', symbol: '–', label: '已取消' },
];

export const RISK_LABEL: Readonly<Record<RiskLevel, string>> = {
  low: '低危', medium: '中危', high: '高危',
};

/** UI 能力门禁（镜像后端 ROLE_CAPABILITIES，仅作交互 gating） */
const ROLE_CAPABILITIES: Readonly<Record<UserRole, readonly string[]>> = {
  viewer: ['read'],
  operator: ['read', 'action:create'],
  approver: ['read', 'action:create', 'action:approve', 'alerts:write'],
  admin: ['read', 'action:create', 'action:approve', 'alerts:write', 'users:manage'],
};

export function can(role: UserRole, capability: string): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) === true;
}

/**
 * 拖拽落点 → 治理意图（受约束迁移，spec 产品规则）：
 * pending→approved = 批准；pending→rejected = 否决；其余一律 null（回弹 + 提示）。
 */
export function transitionIntent(from: ActionStatus, to: ActionStatus): { kind: 'approve' } | { kind: 'reject' } | null {
  if (from === 'pending' && to === 'approved') return { kind: 'approve' };
  if (from === 'pending' && to === 'rejected') return { kind: 'reject' };
  return null;
}

/** 卡片命令展示截断（对齐 CLI 60 列惯例；截断必须提示"详情看全文"） */
export const COMMAND_DISPLAY_WIDTH = 60;

export function truncateCommand(command: string, width = COMMAND_DISPLAY_WIDTH): { text: string; truncated: boolean } {
  const single = command.replace(/\s+/g, ' ').trim();
  if (single.length <= width) return { text: single, truncated: false };
  return { text: `${single.slice(0, width)}…`, truncated: true };
}

/** 发起者显示名（红队 U2：agent 名字优先，human 用 actorId，缺失回退短 ID） */
export function actorDisplay(actorType: string, actorName: string | undefined, actorId: string): string {
  if (actorType === 'agent') return actorName !== undefined && actorName !== '' ? actorName : actorId;
  return actorId;
}
