/**
 * 读侧范围（红队 V5）：agent 令牌经 REST/MCP 读到的面与其权限三件套的资产范围一致。
 * human（本地信任模型）与 Web 会话用户不受限；agent 按 assetPatterns 过滤。
 * CLI 门口校验（assertAgentMayCreateAction）管写侧，本模块管读侧，同一套 globMatch 语义。
 */
import { createError, ERROR_CODES } from '../errors/errors';
import { getAgent, globMatch, type ActorRef, type Agent } from './agents';
import type { Asset } from './assets';

/** agent 身份返回其 Agent 记录；human 返回 undefined（不受限） */
export function agentOrNull(actor: ActorRef): Agent | undefined {
  if (actor.type !== 'agent') return undefined;
  return getAgent(actor.id);
}

export function assetVisible(agent: Agent | undefined, assetName: string): boolean {
  if (agent === undefined) return true;
  return agent.assetPatterns.some((pattern) => globMatch(pattern, assetName));
}

/** 资产过滤：agents 范围外资产对 agent 不可见（human 全量） */
export function filterAssetsForActor(actor: ActorRef, assets: readonly Asset[]): Asset[] {
  const agent = agentOrNull(actor);
  if (agent === undefined) return [...assets];
  return assets.filter((asset) => assetVisible(agent, asset.name));
}

/** 单资产可见性门槛：越范围读取 → PERMISSION_DENIED（403） */
export function assertAssetVisible(actor: ActorRef, assetName: string): void {
  const agent = agentOrNull(actor);
  if (!assetVisible(agent, assetName)) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, `目标（${assetName}）不在该 agent 资产授权范围（读操作同样受限）`, {
      context: { target: assetName, patterns: agent?.assetPatterns },
    });
  }
}

/** 行动可见性门槛：行动目标越范围 → 拒绝（含执行输出等细节） */
export function assertActionVisible(actor: ActorRef, action: { readonly id: string; readonly targetName: string }): void {
  const agent = agentOrNull(actor);
  if (!assetVisible(agent, action.targetName)) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, `行动 ${action.id} 的目标（${action.targetName}）不在该 agent 资产授权范围`, {
      context: { actionId: action.id, target: action.targetName, patterns: agent?.assetPatterns },
    });
  }
}
