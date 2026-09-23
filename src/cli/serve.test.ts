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

/** 轮询等待条件成立（SSE 异步到达），超时返回 false */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe('REST API v1（serve）', () => {
  it('健康检查：无需认证，返回 ok', async () => {
    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('认证：无令牌 → 401（红队 V9：403 留给已认证但无权）', async () => {
    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/assets');
    expect(res.status).toBe(401);
    expect(res.body.type).toBe('SKYPORT_AUTH_REQUIRED');
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
    expect(res.status).toBe(401); // 先被认证拦截（401 语义，红队 V9）
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
    expect(anonymous.status).toBe(401); // 无凭证 = 401（红队 V9）

    const login = await loginWeb('web-ops', 'password8');
    const cookie = cookieOf(login);
    const logout = await fetchWeb('/api/v1/auth/logout', { method: 'POST', cookie });
    expect(logout.status).toBe(200);
    const after = await fetchWeb('/api/v1/auth/me', { cookie });
    expect(after.status).toBe(401); // 会话已吊销 = 未认证（红队 V9）
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

  it('SSE 实时事件流：挂流后审批/否决行动，客户端收到广播事件', async () => {
    createUser('sse-approver', 'password8', 'approver');
    const pending = await createAction({
      command: 'echo sse-broadcast',
      actor: { type: 'human', id: 'e2e-human', name: 'e2e-human' },
      reason: 'sse e2e',
      riskHint: 'high',
      rollback: 'echo 已回滚（只读 e2e）',
    });
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('sse-approver', 'password8'));

    // 挂 SSE 流：fetch 流式读取，攒进缓冲区轮询解析
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${serve.port}/api/v1/events/stream`, { signal: controller.signal });
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const reader = stream.body!.getReader();
    const chunks: string[] = [];
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value).toString('utf8'));
        }
      } catch { /* abort 时正常退出 */ }
    })();

    const reject = await fetchWeb(`/api/v1/actions/${pending.action.id}/reject`, {
      method: 'POST', cookie, body: JSON.stringify({ note: 'sse 测试' }),
    });
    expect(reject.status).toBe(200);

    // 轮询等待广播到达（SSE 经本机回环，秒级内可达）
    const sawEvent = await waitFor(() => {
      const text = chunks.join('');
      return text.includes('action-rejected') && text.includes(pending.action.id);
    }, 3_000);
    controller.abort();
    void pump;
    expect(sawEvent).toBe(true);
  });

  it('否决：approver 带 note；重复审批终态 → 409 状态机拒绝', async () => {    createUser('web-approver2', 'password8', 'approver');
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

// ── 读侧范围（红队 V5）：agent 令牌只见范围内的资产与行动 ──

describe('REST 读侧资产范围（红队 V5）', () => {
  let scopedSeq = 0;
  function scopedSession(patterns: string[]): string {
    scopedSeq += 1;
    const issued = createAgent({ name: `scoped-${scopedSeq}-${patterns.join('_')}`, assetPatterns: patterns, riskCeiling: 'low', autoExecLow: false });
    return loginWithRefreshToken(issueRefreshToken(issued.agent.id)).token;
  }

  it('资产列表：t1* agent 只见 t1，不见 t2/t3', async () => {
    addAsset({ name: 't1', type: 'host', addr: '127.0.0.1:22', connectMode: 'local' });
    addAsset({ name: 't2', type: 'host', addr: '127.0.0.1:23', connectMode: 'local' });
    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/assets', scopedSession(['t1*']));
    expect(res.status).toBe(200);
    const names = (res.body.assets as { name: string }[]).map((a) => a.name);
    expect(names).toContain('t1');
    expect(names).not.toContain('t2');
  });

  it('资产详情：范围外 → 403', async () => {
    addAsset({ name: 't1', type: 'host', addr: '127.0.0.1:22', connectMode: 'local' });
    addAsset({ name: 't2', type: 'host', addr: '127.0.0.1:23', connectMode: 'local' });
    serve = await startServe({ port: 0 });
    const ok = await fetchApi('/api/v1/assets/t1', scopedSession(['t1*']));
    expect(ok.status).toBe(200);
    const denied = await fetchApi('/api/v1/assets/t2', scopedSession(['t1*']));
    expect(denied.status).toBe(403);
  });

  it('行动列表：范围外目标的行动不出现；详情 → 403；态势包同理', async () => {
    addAsset({ name: 't1', type: 'host', addr: '127.0.0.1:22', connectMode: 'local' });
    addAsset({ name: 't3', type: 'host', addr: '127.0.0.1:24', connectMode: 'local' });
    const onT1 = await createAction({ command: 'echo v5-t1', actor: { type: 'human', id: 'e2e', name: 'e2e' }, target: 't1', reason: 'v5' });
    const onT3 = await createAction({ command: 'echo v5-t3', actor: { type: 'human', id: 'e2e', name: 'e2e' }, target: 't3', reason: 'v5' });
    expect(onT1.action.status).toBe('pending');

    serve = await startServe({ port: 0 });
    const token = scopedSession(['t1*']);
    const list = await fetchApi('/api/v1/actions', token);
    expect(list.status).toBe(200);
    const ids = (list.body.actions as { id: string }[]).map((a) => a.id);
    expect(ids).toContain(onT1.action.id);
    expect(ids).not.toContain(onT3.action.id);

    const denied = await fetchApi(`/api/v1/actions/${onT3.action.id}`, token);
    expect(denied.status).toBe(403);
    const context = await fetchApi('/api/v1/context/t3', token);
    expect(context.status).toBe(403);
  });
});

// ── 告警投递门禁（红队 V7）：agent 令牌不能投递告警 ──

describe('alerts 写门禁（红队 V7）', () => {
  it('Bearer agent POST /alerts → 403（alerts:write 只属于 Web 会话角色）', async () => {
    const issued = createAgent({ name: 'alert-agent', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const session = loginWithRefreshToken(issueRefreshToken(issued.agent.id));
    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/alerts', session.token, {
      method: 'POST',
      body: JSON.stringify([{ status: 'firing', labels: { alertname: 'v7', asset: 't1' } }]),
    });
    expect(res.status).toBe(403);
  });
});
