/**
 * watch 值守服务（M3）：轮询 pending 行动并计算"新出现的/已离场的"两类增量。
 * CLI 层负责节奏与展示；这里保持纯数据语义，便于单测。
 */
import { listActions, getAction, type Action, type ActionStatus } from './actions';

export interface PendingDiff {
  /** 新出现的 pending（需要提醒） */
  readonly fresh: readonly Action[];
  /** 上次见过、现已离开 pending 的行动及其当前终态（需要播报结果） */
  readonly resolved: readonly { readonly id: string; readonly status: ActionStatus }[];
  /** 本轮全部 pending（作为下一轮的"已见"集合） */
  readonly currentPendingIds: readonly string[];
}

/** seen = 上一轮的 pending id 集合；首轮传空集合即全部视为"新出现" */
export function pollPending(seen: ReadonlySet<string>): PendingDiff {
  const pending = listActions('pending');
  const currentIds = pending.map((action) => action.id);
  const fresh = pending.filter((action) => !seen.has(action.id));
  const resolvedIds = [...seen].filter((id) => !currentIds.includes(id));
  const resolved = resolvedIds.map((id) => {
    const action = getAction(id);
    return { id, status: action.status };
  });
  return { fresh, resolved, currentPendingIds: currentIds };
}
