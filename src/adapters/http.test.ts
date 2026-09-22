import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isSkyportError } from '../errors/errors';
import { httpRequest } from './http';

const servers: Server[] = [];

afterEach(async () => {
  const closing = servers.splice(0).map(
    (server) =>
      new Promise<void>((resolve) => {
        // 先掐断未完成连接再关闭，避免挂住的请求拖慢测试退出
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  await Promise.all(closing);
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function captureHttpError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isSkyportError(error)) return error.type;
    throw error;
  }
  throw new Error('期望 http 适配器抛错，但它正常返回了');
}

describe('http 网络适配器', () => {
  it('正常路径：返回结构化结果 { status, body, durationMs }', async () => {
    const server = createServer((_req, res) => {
      res.end('pong');
    });
    servers.push(server);
    const url = await listen(server);
    const response = await httpRequest(`${url}/ping`);
    expect(response.status).toBe(200);
    expect(response.body).toBe('pong');
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('失败路径-超时：服务端挂住不响应 → NETWORK_TIMEOUT', async () => {
    const server = createServer(() => undefined); // 收到请求但永不响应
    servers.push(server);
    const url = await listen(server);
    const type = await captureHttpError(() => httpRequest(url, { timeoutMs: 150 }));
    expect(type).toBe('SKYPORT_NETWORK_TIMEOUT');
  });

  it('失败路径-非法 URL：解析失败 → NETWORK_REQUEST_FAILED', async () => {
    const type = await captureHttpError(() => httpRequest('not-a-valid-url', { timeoutMs: 1_000 }));
    expect(type).toBe('SKYPORT_NETWORK_REQUEST_FAILED');
  });
});
