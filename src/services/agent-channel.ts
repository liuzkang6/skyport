/**
 * 节点 agent 反向通道（PRD v0.4 Teleport 式能力收尾）：
 * 命令执行不再依赖网关直连 SSH——agent 主动出站挂住一条 SSE 长连接，
 * 网关把已审批的命令从这条连接推下去，agent 本地执行后 POST 回传结果。
 *
 * 信任模型与心跳一致：agent 持令牌认证，自报 hostname（等价于它代表哪台资产）。
 * 通道键 = 资产名；同一资产允许多条并发连接（互为热备，任一连接可达即可下发）。
 * 通道在线但执行失败就是失败——不回退 SSH（避免同一命令双路径重复执行）。
 */
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/config';
import { rootLogger } from '../logger/logger';

/** 下行载荷：经 SSE data: 帧推给 agent */
export interface AgentExecRequest {
  readonly event: 'exec';
  readonly requestId: string;
  readonly command: string;
  readonly timeoutMs: number;
}

/** 上行结果：agent POST /api/v1/agent/result 的载荷 */
export interface AgentExecResult {
  readonly requestId: string;
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

type Sender = (payload: Readonly<Record<string, unknown>>) => void;

interface PendingRequest {
  readonly assetName: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (result: AgentExecResult) => void;
}

/** assetName → 在线连接集合 */
const channels = new Map<string, Set<Sender>>();
/** requestId → 待回传请求 */
const pending = new Map<string, PendingRequest>();

export function registerChannel(assetName: string, sender: Sender): void {
  const set = channels.get(assetName) ?? new Set<Sender>();
  set.add(sender);
  channels.set(assetName, set);
  rootLogger.info('agent 通道已连接', { asset: assetName, connections: set.size });
}

export function unregisterChannel(assetName: string, sender: Sender): void {
  const set = channels.get(assetName);
  if (set === undefined) return;
  set.delete(sender);
  if (set.size === 0) {
    channels.delete(assetName);
    rootLogger.info('agent 通道已断开', { asset: assetName });
  }
}

export function isAssetChannelConnected(assetName: string): boolean {
  return (channels.get(assetName)?.size ?? 0) > 0;
}

export function listConnectedAssets(): readonly string[] {
  return [...channels.keys()];
}

/**
 * 向资产的反向通道下发一条命令，等待 agent 回传结果。
 * 超时（缺省取网关执行超时配置）视为该命令超时失败。
 */
export function dispatchToAsset(assetName: string, command: string): Promise<AgentExecResult> {
  const senders = channels.get(assetName);
  if (senders === undefined || senders.size === 0) {
    return Promise.resolve({
      requestId: '',
      ok: false,
      stdout: '',
      stderr: `资产 ${assetName} 无在线 agent 通道`,
      exitCode: undefined,
      durationMs: 0,
      timedOut: false,
    });
  }
  const requestId = randomUUID();
  const timeoutMs = getConfig().execTimeoutMs;
  const request: AgentExecRequest = { event: 'exec', requestId, command, timeoutMs };
  return new Promise<AgentExecResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      rootLogger.warn('agent 通道执行超时', { asset: assetName, requestId, timeoutMs });
      resolve({
        requestId,
        ok: false,
        stdout: '',
        stderr: `agent 通道执行超时（${timeoutMs}ms）`,
        exitCode: undefined,
        durationMs: timeoutMs,
        timedOut: true,
      });
    }, timeoutMs);
    pending.set(requestId, { assetName, timer, resolve });
    // 任一在途连接下发；send 失败的连接当场摘除
    for (const sender of [...senders]) {
      try {
        sender(request as unknown as Readonly<Record<string, unknown>>);
      } catch {
        unregisterChannel(assetName, sender);
      }
    }
  });
}

/** agent 回传结果：resolve 对应的 pending 请求 */
export function resolveAgentResult(result: AgentExecResult): boolean {
  const entry = pending.get(result.requestId);
  if (entry === undefined) return false;
  pending.delete(result.requestId);
  clearTimeout(entry.timer);
  entry.resolve(result);
  return true;
}

/** 测试辅助：清空全部通道与挂起请求 */
export function resetChannelsForTest(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  channels.clear();
}
