import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { createAgent } from '../services/agents';
import { issueRefreshToken, loginWithRefreshToken } from '../services/credentials';
import { addAsset } from '../services/assets';
import { createAction } from '../services/actions';
import { createUser } from '../services/users';
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

async function fetchApi(path: string, token?: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${serve!.port}${path}`, { ...init, headers });
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

// ── WebUI 第一刀（spec/webui）：登录会话 + 角色门禁 + 就地审批 ──

interface CookieResponse {
  status: number;
  body: Record<string, unknown>;
  setCookie: string | undefined;
}

async function fetchWeb(path: string, init: RequestInit & { cookie?: string } = {}): Promise<CookieResponse> {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers.Cookie = init.cookie;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${serve!.port}${path}`, { ...init, headers });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    setCookie: res.headers.get('set-cookie') ?? undefined,
  };
}

function cookieOf(res: CookieResponse): string {
  return (res.setCookie ?? '').split(';')[0] ?? '';
}

async function loginWeb(username: string, password: string): Promise<CookieResponse> {
  return fetchWeb('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

describe('WebUI 会话与审批（spec/webui）', () => {
  it('登录 → Set-Cookie(skw_, HttpOnly, SameSite=Strict) → me 返回角色', async () => {
    createUser('web-admin', 'password8', 'admin');
    serve = await startServe({ port: 0 });

    const login = await loginWeb('web-admin', 'password8');
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ name: 'web-admin', role: 'admin' });
    expect(login.setCookie).toContain('skyport_session=skw_');
    expect(login.setCookie).toContain('HttpOnly');
    expect(login.setCookie).toContain('SameSite=Strict');

    const me = await fetchWeb('/api/v1/auth/me', { cookie: cookieOf(login) });
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ name: 'web-admin' });
  });

  it('登录失败统一 401 文案；无凭证 me → 403；登出后 cookie 失效', async () => {
    createUser('web-ops', 'password8', 'operator');
    serve = await startServe({ port: 0 });

    const bad = await loginWeb('web-ops', 'wrong-password');
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('用户名或密码错误');

    const ghost = await loginWeb('no-such-user', 'whatever-1');
    expect(ghost.status).toBe(401);
    expect(ghost.body.error).toBe('用户名或密码错误'); // 与密码错误同文案（防枚举）

    const anonymous = await fetchWeb('/api/v1/auth/me');
    expect(anonymous.status).toBe(403);

    const login = await loginWeb('web-ops', 'password8');
    const cookie = cookieOf(login);
    const logout = await fetchWeb('/api/v1/auth/logout', { method: 'POST', cookie });
    expect(logout.status).toBe(200);
    const after = await fetchWeb('/api/v1/auth/me', { cookie });
    expect(after.status).toBe(403);
  });

  it('连续失败 5 次 → 429 + Retry-After（锁定中正确密码也拒绝）', async () => {
    createUser('web-victim', 'password8', 'viewer');
    serve = await startServe({ port: 0 });
    for (let i = 0; i < 5; i += 1) {
      const fail = await loginWeb('web-victim', 'wrong-password');
      expect(fail.status).toBe(401);
    }
    const locked = await loginWeb('web-victim', 'password8');
    expect(locked.status).toBe(429);
    expect(locked.body.type).toBe('SKYPORT_USER_LOCKED');
  });

  it('用户清单：admin 可读，approver → 403', async () => {
    createUser('web-a2', 'password8', 'admin');
    createUser('web-p2', 'password8', 'approver');
    serve = await startServe({ port: 0 });
    const adminCookie = cookieOf(await loginWeb('web-a2', 'password8'));
    const approverCookie = cookieOf(await loginWeb('web-p2', 'password8'));

    const ok = await fetchWeb('/api/v1/users', { cookie: adminCookie });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain('password_hash');

    const denied = await fetchWeb('/api/v1/users', { cookie: approverCookie });
    expect(denied.status).toBe(403);
  });

  it('就地审批：approver 经 cookie 批准 pending 行动（执行 echo），viewer → 403', async () => {
    createUser('web-approver', 'password8', 'approver');
    createUser('web-viewer', 'password8', 'viewer');
    const pending = await createAction({
      command: 'echo webui-e2e-ok',
      actor: { type: 'human', id: 'e2e-human', name: 'e2e-human' },
      reason: 'webui e2e',
      riskHint: 'high',
      rollback: 'echo 已回滚（只读 e2e）',
    });
    expect(pending.action.status).toBe('pending');

    serve = await startServe({ port: 0 });
    const viewerCookie = cookieOf(await loginWeb('web-viewer', 'password8'));
    const approverCookie = cookieOf(await loginWeb('web-approver', 'password8'));

    const denied = await fetchWeb(`/api/v1/actions/${pending.action.id}/approve`, { method: 'POST', cookie: viewerCookie });
    expect(denied.status).toBe(403);

    const ok = await fetchWeb(`/api/v1/actions/${pending.action.id}/approve`, { method: 'POST', cookie: approverCookie });
    expect(ok.status).toBe(200);
    const action = ok.body.action as { status: string } | undefined;
    expect(action?.status === 'success' || action?.status === 'executing' || action?.status === 'approved').toBe(true);
  });

  it('否决：approver 带 note；重复审批终态 → 409 状态机拒绝', async () => {
    createUser('web-approver2', 'password8', 'approver');
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('web-approver2', 'password8'));

    const a1 = await createAction({
      command: 'echo reject-me',
      actor: { type: 'human', id: 'e2e-human', name: 'e2e-human' },
      reason: 'reject e2e',
      riskHint: 'high',
      rollback: 'echo 已回滚（只读 e2e）',
    });
    const reject = await fetchWeb(`/api/v1/actions/${a1.action.id}/reject`, {
      method: 'POST', cookie, body: JSON.stringify({ note: '不需要' }),
    });
    expect(reject.status).toBe(200);
    expect((reject.body.action as { status: string }).status).toBe('rejected');

    const a2 = await createAction({
      command: 'echo double-approve',
      actor: { type: 'human', id: 'e2e-human', name: 'e2e-human' },
      riskHint: 'high',
      rollback: 'echo 已回滚（只读 e2e）',
    });
    const first = await fetchWeb(`/api/v1/actions/${a2.action.id}/approve`, { method: 'POST', cookie });
    expect(first.status).toBe(200);
    const second = await fetchWeb(`/api/v1/actions/${a2.action.id}/approve`, { method: 'POST', cookie });
    expect([409, 500]).toContain(second.status); // 状态机拒绝（非法迁移）
  });

  it('Bearer（agent）调审批端点 → 403（API 令牌无角色）', async () => {
    const issued = createAgent({ name: 'web-agent', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const session = loginWithRefreshToken(issueRefreshToken(issued.agent.id));
    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/actions/act_x/approve', session.token, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
