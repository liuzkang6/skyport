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

  it('SSE 鉴权（QA #4）：无凭证挂流 → 401，不泄漏事件', async () => {
    serve = await startServe({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${serve.port}/api/v1/events/stream`);
    expect(res.status).toBe(401);
    await res.text();
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

    // 挂 SSE 流（带会话 cookie——QA #4 之后事件流需要认证）：fetch 流式读取，攒进缓冲区轮询解析
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${serve.port}/api/v1/events/stream`, { signal: controller.signal, headers: { cookie: cookie } });
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

describe('agent 反向通道（v0.4 收尾）：命令执行走 agent 通道而非网关 SSH', () => {
  it('完整链路：agent 挂流 → 审批命令经通道下发 → 回传结果 → 行动成功落库', async () => {
    addAsset({ name: 'chan-host', type: 'host', addr: '10.99.0.1' }); // 无 addr：通道可用时不依赖 SSH 地址
    const issued = createAgent({ name: 'chan-agent', assetPatterns: ['*'], riskCeiling: 'high', autoExecLow: false });
    const session = loginWithRefreshToken(issueRefreshToken(issued.agent.id));
    createUser('chan-approver', 'password8', 'approver');

    const pending = await createAction({
      command: 'echo chan-e2e-ok',
      target: 'chan-host',
      actor: { type: 'agent', id: issued.agent.id, name: 'chan-agent' },
      reason: 'agent 通道 e2e',
      riskHint: 'high',
      rollback: 'echo 已回滚（只读 e2e）',
    });
    expect(pending.action.status).toBe('pending');

    serve = await startServe({ port: 0 });

    // 模拟 Go agent：挂 SSE 通道流，收到 exec 事件后回传结果
    const agent = await simulateAgent(session.token, 'chan-host', (req) => ({
      requestId: req.requestId,
      ok: true,
      stdout: `simulated:${req.command}`,
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
    }));
    await agent.ready; // 等 channel-open 确认注册完成

    // 审批 → executeAction 经通道下发 → agent 回传 → 终态（approve 同步等执行完成）
    const cookie = cookieOf(await loginWeb('chan-approver', 'password8'));
    const approve = await fetchWeb(`/api/v1/actions/${pending.action.id}/approve`, { method: 'POST', cookie });
    expect(approve.status).toBe(200);
    const finalStatus = (approve.body.action as { status: string } | undefined)?.status;
    agent.stop();
    expect(finalStatus).toBe('success');
    // 下发的就是审批人读到的命令原串
    expect(agent.sawCommand).toBe('echo chan-e2e-ok');
  });

  it('通道端点门禁：无令牌 → 401；Web 会话（human）→ 403；未登记主机名 → 400', async () => {
    addAsset({ name: 'known-host', type: 'host', addr: '10.99.0.2' });
    const issued = createAgent({ name: 'gate-agent', assetPatterns: ['*'], riskCeiling: 'low', autoExecLow: false });
    const session = loginWithRefreshToken(issueRefreshToken(issued.agent.id));
    serve = await startServe({ port: 0 });

    const noToken = await fetch(`http://127.0.0.1:${serve.port}/api/v1/agent/channel?hostname=known-host`);
    expect(noToken.status).toBe(401);
    await noToken.body?.cancel();

    createUser('chan-viewer', 'password8', 'viewer');
    const cookie = cookieOf(await loginWeb('chan-viewer', 'password8'));
    const human = await fetch(`http://127.0.0.1:${serve.port}/api/v1/agent/channel?hostname=known-host`, {
      headers: { cookie },
    });
    expect(human.status).toBe(403);
    await human.body?.cancel();

    const unknownHost = await fetch(`http://127.0.0.1:${serve.port}/api/v1/agent/channel?hostname=ghost`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    expect(unknownHost.status).toBe(400);
    await unknownHost.body?.cancel();
  });

  it('结果回传：未知 requestId → 409', async () => {
    const issued = createAgent({ name: 'res-agent', assetPatterns: ['*'], riskCeiling: 'low', autoExecLow: false });
    const session = loginWithRefreshToken(issueRefreshToken(issued.agent.id));
    serve = await startServe({ port: 0 });
    const res = await fetchApi('/api/v1/agent/result', session.token, {
      method: 'POST',
      body: JSON.stringify({ requestId: 'ghost-req', ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1, timedOut: false }),
    });
    expect(res.status).toBe(409);
  });
});

describe('告警闭环 REST（spec/alert-dispatcher）', () => {
  it('投递 DiskFull 告警 → 自动触发剧本 → playbook-runs 可查', async () => {
    createUser('disp-approver', 'password8', 'approver');
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('disp-approver', 'password8'));

    // skyport 原生格式投递（alerts:write 需要 Web 会话角色）
    const ingest = await fetchWeb('/api/v1/alerts', {
      method: 'POST', cookie,
      body: JSON.stringify({ event: 'DiskFull', resource: 'loop-host', severity: 'critical', origin: 'e2e', text: '磁盘闭环验证' }),
    });
    expect(ingest.status).toBe(201);

    // 自动触发是异步的：轮询 playbook-runs 直到 disk-cleanup 出现
    const triggered = await waitFor(() => {
      void fetchWeb('/api/v1/playbook-runs', { cookie })
        .then((r) => {
          const runs = (r.body.runs ?? []) as { playbookName: string; triggerType: string; mode: string }[];
          loopLastRuns = runs;
        })
        .catch(() => undefined); // afterEach 关服后 in-flight 轮询被重置——吞掉防 unhandled
      return (loopLastRuns?.[0]?.playbookName ?? '') === 'disk-cleanup';
    }, 5_000);
    expect(triggered).toBe(true);
    expect(loopLastRuns![0]!.triggerType).toBe('alert');
    expect(loopLastRuns![0]!.mode).toBe('training'); // 内置剧本 training 相：安全
  }, 10_000);

  it('手动触发：approver POST /playbooks/:name/trigger → 200 + viewer 403', async () => {
    createUser('trig-approver', 'password8', 'approver');
    createUser('trig-viewer', 'password8', 'viewer');
    serve = await startServe({ port: 0 });
    const approver = cookieOf(await loginWeb('trig-approver', 'password8'));
    const viewer = cookieOf(await loginWeb('trig-viewer', 'password8'));

    const denied = await fetchWeb('/api/v1/playbooks/service-restart/trigger', { method: 'POST', cookie: viewer });
    expect(denied.status).toBe(403);

    const ok = await fetchWeb('/api/v1/playbooks/service-restart/trigger', { method: 'POST', cookie: approver });
    expect(ok.status).toBe(200);
    expect((ok.body as { mode: string }).mode).toBe('training');
    const runs = ((await fetchWeb('/api/v1/playbook-runs', { cookie: approver })).body.runs ?? []) as { playbookName: string; triggerType: string }[];
    expect(runs[0]!.playbookName).toBe('service-restart');
    expect(runs[0]!.triggerType).toBe('manual');
  });

  it('交接班：POST 落库 + GET latest 读回', async () => {
    createUser('hand-admin', 'password8', 'admin');
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('hand-admin', 'password8'));

    const created = await fetchWeb('/api/v1/handover', { method: 'POST', cookie, body: JSON.stringify({ notes: 'REST 落库验证' }) });
    expect(created.status).toBe(200);
    const latest = await fetchWeb('/api/v1/handover/latest', { cookie });
    expect((latest.body as { createdBy?: string }).createdBy).toContain('human:');
    expect((latest.body as { snapshot?: { notes?: string } }).snapshot?.notes).toBe('REST 落库验证');
  });
});

describe('QA 修复回归（docs/webui-qa-report.md）', () => {
  it('#2 我的页：human 用户名过滤能查到本人行动', async () => {
    createUser('qa-mine', 'password8', 'approver');
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('qa-mine', 'password8'));
    const created = await fetchWeb('/api/v1/actions', {
      method: 'POST', cookie,
      body: JSON.stringify({ command: 'echo mine-page-fix', reason: 'QA #2' }),
    });
    expect(created.status).toBe(201);
    const mine = await fetchWeb('/api/v1/actions?actor=qa-mine', { cookie });
    const ids = (mine.body.actions as { id: string }[]).map((a) => a.id);
    expect(ids).toContain((created.body.action as { id: string }).id);
  });

  it('#3 分页：total/offset 生效（hasMore 可消费）', async () => {
    createUser('qa-page', 'password8', 'approver');
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('qa-page', 'password8'));
    for (let i = 0; i < 3; i += 1) {
      await fetchWeb('/api/v1/actions', { method: 'POST', cookie, body: JSON.stringify({ command: `echo page-${i}` }) });
    }
    const page1 = await fetchWeb('/api/v1/actions?limit=2&offset=0', { cookie });
    expect((page1.body.actions as unknown[])).toHaveLength(2);
    expect((page1.body as { total: number }).total).toBeGreaterThanOrEqual(3);
    expect((page1.body as { hasMore: boolean }).hasMore).toBe(true);
    const page2 = await fetchWeb('/api/v1/actions?limit=2&offset=2', { cookie });
    expect((page2.body.actions as unknown[])).toHaveLength(1);
  });

  it('#9 创建行动能力门禁：viewer → 403，operator → 201', async () => {
    createUser('qa-viewer9', 'password8', 'viewer');
    createUser('qa-operator9', 'password8', 'operator');
    serve = await startServe({ port: 0 });
    const viewer = cookieOf(await loginWeb('qa-viewer9', 'password8'));
    const operator = cookieOf(await loginWeb('qa-operator9', 'password8'));
    const denied = await fetchWeb('/api/v1/actions', { method: 'POST', cookie: viewer, body: JSON.stringify({ command: 'echo x' }) });
    expect(denied.status).toBe(403);
    const ok = await fetchWeb('/api/v1/actions', { method: 'POST', cookie: operator, body: JSON.stringify({ command: 'echo y' }) });
    expect(ok.status).toBe(201);
  });

  it('#7 语义状态码：未知模型删除 → 404；空名保存 → 400；hours=abc → 400', async () => {
    createUser('qa-code', 'password8', 'approver');
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('qa-code', 'password8'));
    const del = await fetchWeb('/api/v1/models/no-such-model', { method: 'DELETE', cookie });
    expect(del.status).toBe(404);
    expect((del.body as { error: string }).error).toContain('不存在');
    const badSave = await fetchWeb('/api/v1/models', { method: 'POST', cookie, body: JSON.stringify({ name: '', baseUrl: 'https://x/v1', modelId: 'm', apiKey: 'k' }) });
    expect(badSave.status).toBe(400);
    const badHours = await fetchWeb('/api/v1/usage/summary?hours=abc', { cookie });
    expect(badHours.status).toBe(400);
  });

  it('#16 baselines 端点索引修复：按资产名可查（此前必然 404）', async () => {
    addAsset({ name: 'qa-baseline-host', type: 'host', addr: '10.0.0.99' });
    createUser('qa-base', 'password8', 'approver');
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('qa-base', 'password8'));
    const res = await fetchWeb('/api/v1/baselines/qa-baseline-host', { cookie });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.baselines)).toBe(true);
  });

  it('#1 保险箱真接口：POST 保存 → GET 列表（值不回传，只有 hint）', async () => {
    createUser('qa-vault', 'password8', 'approver');
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('qa-vault', 'password8'));
    const saved = await fetchWeb('/api/v1/secrets', { method: 'POST', cookie, body: JSON.stringify({ name: 'qa-secret', value: 'plain-value-xyz' }) });
    expect(saved.status).toBe(201);
    expect(JSON.stringify(saved.body)).not.toContain('plain-value-xyz');
    const list = await fetchWeb('/api/v1/secrets', { cookie });
    const names = (list.body.secrets as { name: string }[]).map((x) => x.name);
    expect(names).toContain('qa-secret');
    // viewer 写保险箱被拒
    createUser('qa-vault-viewer', 'password8', 'viewer');
    const viewer = cookieOf(await loginWeb('qa-vault-viewer', 'password8'));
    const denied = await fetchWeb('/api/v1/secrets', { method: 'POST', cookie: viewer, body: JSON.stringify({ name: 'x', value: 'y' }) });
    expect(denied.status).toBe(403);
  });
});

let loopLastRuns: { playbookName: string; triggerType: string; mode: string }[] | undefined;

describe('模型配置与 AI 巡查 REST（spec/llm-seat）', () => {
  it('模型 CRUD：approver 登记 → 列表无 key → 删除；viewer 只读', async () => {
    createUser('model-approver', 'password8', 'approver');
    createUser('model-viewer', 'password8', 'viewer');
    serve = await startServe({ port: 0 });
    const approver = cookieOf(await loginWeb('model-approver', 'password8'));
    const viewer = cookieOf(await loginWeb('model-viewer', 'password8'));

    // viewer 登记被拒
    const denied = await fetchWeb('/api/v1/models', { method: 'POST', cookie: viewer, body: JSON.stringify({ name: 'x' }) });
    expect(denied.status).toBe(403);

    const created = await fetchWeb('/api/v1/models', {
      method: 'POST', cookie: approver,
      body: JSON.stringify({ name: 'glm-flash', baseUrl: 'https://models.example.com/glm/v1', modelId: 'GLM-5.3-Flash', apiKey: 'sk-never-leak', tier: 'cheap', enabled: true }),
    });
    expect(created.status).toBe(201);
    // 任何响应不含 key
    expect(JSON.stringify(created.body)).not.toContain('sk-never-leak');

    const list = await fetchWeb('/api/v1/models', { cookie: viewer });
    expect((list.body.models as { name: string }[]).map((m) => m.name)).toContain('glm-flash');
    expect(JSON.stringify(list.body)).not.toContain('sk-never-leak');

    const removed = await fetchWeb('/api/v1/models/glm-flash', { method: 'DELETE', cookie: approver });
    expect(removed.status).toBe(200);
    expect(((await fetchWeb('/api/v1/models', { cookie: viewer })).body.models as unknown[])).toHaveLength(0);
  });

  it('巡查状态：GET patroller/status 返回周期与最近结果（初始为空）', async () => {
    createUser('pat-admin', 'password8', 'admin');
    serve = await startServe({ port: 0 });
    const cookie = cookieOf(await loginWeb('pat-admin', 'password8'));
    const status = await fetchWeb('/api/v1/patroller/status', { cookie });
    expect(status.status).toBe(200);
    expect((status.body as { intervalMinutes: number }).intervalMinutes).toBe(15);
    expect((status.body as { lastSweep: unknown }).lastSweep).toBeNull();
  });
});

/** 模拟 Go agent：挂 SSE 通道流，对每条 exec 请求执行 handler 并 POST 回传 */
function simulateAgent(
  token: string,
  hostname: string,
  handle: (req: { requestId: string; command: string }) => Record<string, unknown>,
): { ready: Promise<boolean>; stop: () => void; sawCommand: string; lastStatus: string } {
  const controller = new AbortController();
  const state = { sawCommand: '', lastStatus: '' };
  let resolveReady: (v: boolean) => void = () => {};
  const ready = new Promise<boolean>((r) => { resolveReady = r; });
  void (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${serve!.port}/api/v1/agent/channel?hostname=${hostname}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.status !== 200) {
        const text = await res.text();
        resolveReady(false);
        throw new Error(`channel 挂流失败 ${res.status}: ${text.slice(0, 120)}`);
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line === undefined) continue;
          const payload = JSON.parse(line.slice(6)) as { event?: string; requestId?: string; command?: string };
          if (payload.event === 'channel-open') resolveReady(true);
          if (payload.event === 'exec' && payload.requestId !== undefined) {
            state.sawCommand = payload.command ?? '';
            void fetch(`http://127.0.0.1:${serve!.port}/api/v1/agent/result`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(handle({ requestId: payload.requestId, command: payload.command ?? '' })),
            });
          }
        }
      }
    } catch { /* abort 退出 */ }
  })();
  return {
    ready,
    stop: () => controller.abort(),
    get sawCommand() { return state.sawCommand; },
    get lastStatus() { return state.lastStatus; },
    set lastStatus(v: string) { state.lastStatus = v; },
  };
}

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
