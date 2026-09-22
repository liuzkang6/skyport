/**
 * 跳板治理（红队 S4）：命令内嵌 ssh/scp 的二级目标资产范围校验。
 * 从 actions 拆出（单文件 ≤400 行规矩）；人是 root 不做范围校验，风险地板仍由引擎给出。
 */
import { createError, ERROR_CODES } from '../errors/errors';
import { getAgent, globMatch, type ActorRef } from './agents';
import { listAssets, parseAddr, type Asset } from './assets';

/** 二级目标解析：跳板主机名对应哪台已登记资产（按名字或地址主机部分） */
export function findAssetByTarget(target: string): Asset | undefined {
  const all = listAssets();
  const byName = all.find((asset) => asset.name === target);
  if (byName !== undefined) return byName;
  return all.find((asset) => {
    if (asset.addr === undefined) return false;
    try {
      return parseAddr(asset.addr, asset.connectMode).host === target;
    } catch {
      return false;
    }
  });
}

/** agent 的跳板目标必须在授权资产范围内；未登记主机靠引擎的 ≥medium/高风险地板兜底 */
export function assertPivotScope(actor: ActorRef, pivots: readonly string[]): void {
  if (actor.type !== 'agent') return;
  const agent = getAgent(actor.id);
  for (const pivot of pivots) {
    const asset = findAssetByTarget(pivot);
    if (asset === undefined) continue;
    if (!agent.assetPatterns.some((pattern) => globMatch(pattern, asset.name))) {
      throw createError(ERROR_CODES.PERMISSION_DENIED, `命令内嵌跳板目标不在 agent 资产授权范围: ${pivot}`, {
        context: { agent: agent.name, pivot, patterns: agent.assetPatterns },
      });
    }
  }
}
