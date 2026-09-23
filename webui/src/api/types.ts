/** REST 投影类型（与 src/services/actions.ts、users.ts 的对外形状一致；UI 只消费投影） */
import type { ActionStatus, RiskLevel, UserRole } from '../lib/governance';

export interface ApiAction {
  readonly id: string;
  readonly command: string;
  readonly targetName: string;
  readonly targetKind: string;
  readonly reason: string | undefined;
  readonly rollback: string | undefined;
  readonly riskLevel: RiskLevel;
  readonly status: ActionStatus;
  readonly actorType: 'human' | 'agent';
  readonly actorId: string;
  readonly actorName: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApiActionPage {
  readonly actions: readonly ApiAction[];
  readonly hasMore: boolean;
}

export interface ApiUser {
  readonly id: string;
  readonly name: string;
  readonly role: UserRole;
}

export interface ApiActionResult {
  readonly action: ApiAction;
  readonly execution: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean } | undefined;
}
