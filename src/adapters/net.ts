/**
 * TCP 网络探测适配器 —— 资产连通性检查的唯一出口（AGENTS.md §4）。
 * 设计：探测结果一律作为数据返回（ok=false 不是异常），只有调用方 misuse 才在上层报错。
 */
import { createConnection } from 'node:net';

export interface TcpCheckResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error: string | undefined;
}

/** TCP 握手探测：连接成功/失败/超时都返回结果，不抛异常 */
export function tcpConnectCheck(host: string, port: number, timeoutMs: number): Promise<TcpCheckResult> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean, error: string | undefined): void => {
      socket.destroy();
      resolve({ ok, latencyMs: Math.round(performance.now() - startedAt), error });
    };
    socket.setTimeout(timeoutMs, () => finish(false, `连接超时（${timeoutMs}ms）`));
    socket.on('connect', () => finish(true, undefined));
    socket.on('error', (error: Error) => finish(false, error.message));
  });
}
