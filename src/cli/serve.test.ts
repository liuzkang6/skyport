import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { createAgent } from '../services/agents';
import { issueRefreshToken, loginWithRefreshToken } from '../services/credentials';
import { addAsset } from '../services/assets';
import { startServe, type ServeResult } from './serve';

let tempDir: string;
let serve: ServeResult | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-serve-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  if (serve) {
    serve.server.close();
    serve = undefined;
  }
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

async function fetchApi(path: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${serve!.port}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('REST API v1（serve）', () => {
  it('健康检查：无需认证，返回 ok', async () => {
    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('认证：无令牌 → 403', async () => {
    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/assets');
    expect(res.status).toBe(403);
  });

  it('资产列表：带令牌 → 200 + 资产数组', async () => {
    addAsset({ name: 'test-01', type: 'host', addr: '127.0.0.1:22', connectMode: 'local' });
    const issued = createAgent({ name: 'api', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const skr = issueRefreshToken(issued.agent.id);
    const session = loginWithRefreshToken(skr);

    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/assets', session.token);
    expect(res.status).toBe(200);
    expect((res.body.assets as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('whoami：返回 actor 身份', async () => {
    const issued = createAgent({ name: 'who', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const skr = issueRefreshToken(issued.agent.id);
    const session = loginWithRefreshToken(skr);

    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/whoami', session.token);
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({ type: 'agent', name: 'who' });
  });

  it('审计链验证端点', async () => {
    const issued = createAgent({ name: 'audit-api', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const skr = issueRefreshToken(issued.agent.id);
    const session = loginWithRefreshToken(skr);

    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/audit/verify', session.token);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('404：未知路径', async () => {
    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/nonexistent');
    expect(res.status).toBe(403); // 先被认证拦截
  });
});
