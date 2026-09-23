/**
 * REST API v1（PRD 接口层）：serve 骨架 + 核心端点。
 * 权威接口：所有能力资源化在 REST；MCP 适配器翻译到此层。
 * 认证双轨（spec/webui）：Authorization: Bearer <sks_|skp_|skr_>（API 消费方）
 * 或 Web 会话 cookie skyport_session=skw_...（浏览器，角色四分门禁）。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createRequire } from 'node:module';
// 版本号经 createRequire 解析：src（tsx 运行）与 dist（esbuild 产物）相对深度一致
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { rootLogger } from '../logger/logger';
import { resolveActorWithSessions } from '../services/credentials';
import { listActions, getAction } from '../services/action-queries';
import { listAssets, getAsset } from '../services/assets';
import { listServicesScoped } from '../services/cmdb';
import { verifyAuditChain } from '../services/audit-chain';
import { detectAndParse, ingestAlert, listAlerts, ackAlert, closeAlert, getAlertStats } from '../services/alert-bus';
import { buildContextPack, summarizeContextPack } from '../services/context-pack';
import { approveAction, rejectAction } from '../services/actions';
import { agentOrNull, assertActionVisible, assertAssetVisible, filterAssetsForActor } from '../services/read-scope';
import {
  WEB_SESSION_COOKIE, can, issueWebSession, listUsers, revokeWebSession,
  verifyLogin, verifyWebSession, type User,
} from '../services/users';
import type { ActorRef } from '../services/agents';
import { reconcileZombies } from '../services/reconciliation';
import { serveStatic } from './static';

/** 僵尸对账周期：网关常驻期间每 5 分钟自愈一次 */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

/** SSE 活动连接表：broadcastEvent 的推送目标（连接断开自动摘除） */
const sseClients = new Set<ServerResponse>();

/** 向所有已连接的 Web UI 客户端推送一条事件（无连接时静默丢弃） */
function broadcastEvent(payload: Readonly<Record<string, unknown>>): void {
  const line = `data: ${JSON.stringify({ ...payload, timestamp: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

export interface ServeOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
}

export interface ServeResult {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
}

/** 请求身份：Bearer（actor）或 Web 会话（user 带角色，cookieToken 供登出） */
interface RequestAuth {
  readonly actor: ActorRef;
  readonly user: User | undefined;
  readonly cookieToken: string | undefined;
}

/** agent 结果回传载荷（/api/v1/agent/result） */
interface AgentResultBody {
  requestId: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

/** 启动 REST API 服务器（返回 Server 实例供测试用） */
export function startServe(options: ServeOptions = {}): Promise<ServeResult> {
  const port = options.port ?? 7100;
  const host = options.host ?? '127.0.0.1';

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        await route(req, res);
      } catch (error) {
        rootLogger.error('REST API 错误', { method: req.method, url: req.url, error: error instanceof Error ? error.message : String(error) });
        const status = error instanceof Error && isSkyportError(error) ? mapErrorToStatus(error.type) : 500;
        if (status === 429) res.setHeader('Retry-After', '300');
        sendJson(res, status, {
          error: error instanceof Error ? error.message : 'Internal server error',
          type: isSkyportError(error) ? error.type : 'INTERNAL',
        });
      }
    });

    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : port;
      rootLogger.info('REST API 启动', { port: actualPort, host });
      resolve({ server, port: actualPort, host });
    });

    // 僵尸对账（v0.3.x）：网关常驻后每 5 分钟自愈超时 executing 行动；随 server 关闭停止
    const zombieTimer = setInterval(() => {
      try {
        const report = reconcileZombies();
        if (report.reconciled > 0) broadcastEvent({ event: 'zombie-reconciled', report });
      } catch (error) {
        rootLogger.warn('僵尸对账执行失败', { error: error instanceof Error ? error.message : String(error) });
      }
    }, RECONCILE_INTERVAL_MS);
    server.on('close', () => clearInterval(zombieTimer));
  });
}

function mapErrorToStatus(type: string): number {
  // 红队 V9：401 = 未认证（无凭证）；403 留给"认证了但无权"
  if (type === ERROR_CODES.AUTH_REQUIRED) return 401;
  if (type.startsWith('SKYPORT_PERMISSION') || type === 'SKYPORT_USER_DISABLED') return 403;
  if (type === 'SKYPORT_USER_LOCKED') return 429;
  if (type === 'SKYPORT_USER_DUPLICATE_NAME' || type === 'SKYPORT_ACTION_INVALID_STATE') return 409;
  if (type === 'SKYPORT_USER_INVALID') return 400;
  if (type.startsWith('SKYPORT_ASSET_NOT') || type.startsWith('SKYPORT_ACTION_NOT') || type.startsWith('SKYPORT_AGENT_NOT') || type === 'SKYPORT_USER_NOT_FOUND') return 404;
  if (type.startsWith('SKYPORT_ACTION_INVALID') || type.startsWith('SKYPORT_ASSET_INVALID') || type.startsWith('SKYPORT_AGENT_INVALID')) return 400;
  return 500;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

/** 从请求头提取 Bearer 令牌 */
function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth === undefined || !auth.startsWith('Bearer ')) return undefined;
  return auth.slice(7).trim();
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (header === undefined) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name !== '') cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

/** 双轨认证：Bearer（令牌）优先，其次 Web 会话 cookie；都没有返回 undefined */
function resolveAuth(req: IncomingMessage): RequestAuth | undefined {
  const token = extractToken(req);
  if (token !== undefined) {
    return { actor: resolveActorWithSessions(token), user: undefined, cookieToken: undefined };
  }
  const cookieToken = parseCookies(req)[WEB_SESSION_COOKIE];
  if (cookieToken === undefined) return undefined;
  try {
    const user = verifyWebSession(cookieToken);
    return { actor: { type: 'human', id: user.id, name: user.name }, user, cookieToken };
  } catch (error) {
    // 会话无效/过期/闲置 = 没有有效凭证 → 401 语义（红队 V9）；用户被禁用仍是 403
    if (isSkyportError(error) && error.type === ERROR_CODES.PERMISSION_DENIED) {
      throw createError(ERROR_CODES.AUTH_REQUIRED, error.message, { context: {} });
    }
    throw error;
  }
}

/** 认证中间件：无凭证返回 401（AUTH_REQUIRED） */
function requireAuth(req: IncomingMessage): RequestAuth {
  const auth = resolveAuth(req);
  if (auth === undefined) {
    throw createError(ERROR_CODES.AUTH_REQUIRED, '缺少认证凭证（Bearer 或会话 cookie）', { context: {} });
  }
  return auth;
}

/** 角色门禁：Web 会话 + 角色能力集（spec/webui 接口节） */
function requireCapability(req: IncomingMessage, capability: string): RequestAuth {
  const auth = requireAuth(req);
  if (auth.user === undefined) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '该操作需要 Web 登录会话（API 令牌无角色）', { context: { capability } });
  }
  if (!can(auth.user.role, capability)) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, `角色 ${auth.user.role} 无权执行该操作（需要 ${capability}）`, { context: { capability, role: auth.user.role } });
  }
  return auth;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = req.method ?? 'GET';

  // 健康检查（无需认证）
  if (method === 'GET' && path === '/api/v1/health') {
    sendJson(res, 200, { status: 'ok', version: pkg.version, timestamp: new Date().toISOString() });
    return;
  }

  // 节点 agent 心跳（spec/node-agent：记录心跳+采集指标→基线训练数据源）
  if (method === 'POST' && path === '/api/v1/agent/heartbeat') {
    const body = (await readBody(req)) as {
      agent_id?: string; hostname?: string; capabilities?: string[];
      metrics?: { name: string; value: number }[];
    };
    // 按主机名关联资产并记录指标（基线三相训练的数据入口）
    if (body.hostname !== undefined && Array.isArray(body.metrics)) {
      const { getAsset } = await import('../services/assets');
      const { recordMetricPoint } = await import('../services/baseline');
      try {
        const asset = getAsset(body.hostname);
        for (const m of body.metrics) {
          if (typeof m.name === 'string' && typeof m.value === 'number') {
            recordMetricPoint(asset.id, m.name, m.value);
          }
        }
      } catch { /* 主机未登记则跳过指标记录 */ }
    }
    sendJson(res, 200, { status: 'ok', received: true, agentId: body.agent_id ?? 'unknown', timestamp: new Date().toISOString() });
    return;
  }

  // ── agent 反向通道（v0.4 收尾）：SSE 下行 + 结果上行 ──

  // 下行：agent 挂住此流，网关把已审批命令从这条连接推下去（认证：agent 令牌）
  if (method === 'GET' && path === '/api/v1/agent/channel') {
    const auth = resolveAuth(req);
    if (auth === undefined) {
      sendJson(res, 401, { error: '缺少 Bearer 令牌', type: ERROR_CODES.AUTH_REQUIRED });
      return;
    }
    if (auth.actor.type !== 'agent') {
      sendJson(res, 403, { error: 'agent 通道仅接受 agent 令牌', type: ERROR_CODES.PERMISSION_DENIED });
      return;
    }
    const hostname = url.searchParams.get('hostname') ?? '';
    let assetName = '';
    try {
      const { getAsset } = await import('../services/assets');
      const asset = hostname !== '' ? getAsset(hostname) : undefined;
      assetName = asset?.name ?? '';
    } catch { /* 未登记主机：assetName 保持空串，下面统一拒绝 */ }
    if (assetName === '') {
      sendJson(res, 400, { error: `hostname 未登记为资产（先 asset add）`, type: ERROR_CODES.ASSET_NOT_FOUND });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ event: 'channel-open', asset: assetName, agentId: auth.actor.id, timestamp: new Date().toISOString() })}\n\n`);
    const { registerChannel, unregisterChannel } = await import('../services/agent-channel');
    const sender = (payload: Readonly<Record<string, unknown>>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    registerChannel(assetName, sender);
    broadcastEvent({ event: 'agent-channel-open', asset: assetName, agentId: auth.actor.id });
    const keepAlive = setInterval(() => {
      res.write(`: keep-alive\n\n`);
    }, 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unregisterChannel(assetName, sender);
    });
    return;
  }

  // 上行：agent 回传执行结果（resolve 对应 pending 请求）
  if (method === 'POST' && path === '/api/v1/agent/result') {
    const auth = resolveAuth(req);
    if (auth === undefined) {
      sendJson(res, 401, { error: '缺少 Bearer 令牌', type: ERROR_CODES.AUTH_REQUIRED });
      return;
    }
    if (auth.actor.type !== 'agent') {
      sendJson(res, 403, { error: '结果回传仅接受 agent 令牌', type: ERROR_CODES.PERMISSION_DENIED });
      return;
    }
    const body = (await readBody(req)) as Partial<AgentResultBody>;
    if (typeof body.requestId !== 'string' || body.requestId === '') {
      sendJson(res, 400, { error: 'requestId 必填', type: 'SKYPORT_AGENT_INVALID' });
      return;
    }
    // 输出防御：与 executor 同口径截断（100KB），agent 回传不可无限信任
    const cap = 100 * 1024;
    const clip = (s: unknown): string => (typeof s === 'string' ? (s.length > cap ? s.slice(0, cap) : s) : '');
    const result = {
      requestId: body.requestId,
      ok: body.ok === true,
      stdout: clip(body.stdout),
      stderr: clip(body.stderr),
      exitCode: typeof body.exitCode === 'number' ? body.exitCode : undefined,
      durationMs: typeof body.durationMs === 'number' ? body.durationMs : 0,
      timedOut: body.timedOut === true,
    };
    const { resolveAgentResult } = await import('../services/agent-channel');
    const accepted = resolveAgentResult(result);
    if (!accepted) {
      sendJson(res, 409, { error: '未知或已完结的 requestId', type: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }
    sendJson(res, 200, { status: 'ok', requestId: result.requestId });
    return;
  }

  // SSE 事件流（spec/webui：实时推送告警/状态变更；连接注册进表，broadcastEvent 全体推送）
  if (method === 'GET' && path === '/api/v1/events/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ event: 'connected', timestamp: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      res.write(`: keep-alive\n\n`);
    }, 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  // WebUI 静态托管（无需认证：页面外壳公开，数据全部经认证 API；非 /api 路径 SPA fallback）
  if (!path.startsWith('/api/') && (method === 'GET' || method === 'HEAD') && serveStatic(res, path)) {
    return;
  }

  // ── Web 会话认证端点（spec/webui）──

  if (method === 'POST' && path === '/api/v1/auth/login') {
    const body = (await readBody(req)) as { username?: unknown; password?: unknown };
    if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.username === '' || body.password === '') {
      sendJson(res, 400, { error: 'username 与 password 必填', type: 'SKYPORT_USER_INVALID' });
      return;
    }
    try {
      const user = verifyLogin(body.username, body.password);
      const session = issueWebSession(user);
      res.setHeader('Set-Cookie', `${WEB_SESSION_COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      sendJson(res, 200, { user: { id: user.id, name: user.name, role: user.role } });
    } catch (error) {
      // 登录失败（凭证不对）= 401；锁定/禁用按各自错误码走全局映射（429/403）
      if (isSkyportError(error) && error.type === ERROR_CODES.PERMISSION_DENIED) {
        sendJson(res, 401, { error: error.message, type: error.type });
        return;
      }
      throw error;
    }
    return;
  }

  if (method === 'POST' && path === '/api/v1/auth/logout') {
    const cookieToken = parseCookies(req)[WEB_SESSION_COOKIE];
    if (cookieToken !== undefined) revokeWebSession(cookieToken);
    res.setHeader('Set-Cookie', `${WEB_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && path === '/api/v1/auth/me') {
    const auth = requireAuth(req);
    sendJson(res, 200, auth.user === undefined
      ? { actor: auth.actor, user: null }
      : { actor: auth.actor, user: { id: auth.user.id, name: auth.user.name, role: auth.user.role } });
    return;
  }

  if (method === 'GET' && path === '/api/v1/users') {
    requireCapability(req, 'users:manage');
    sendJson(res, 200, { users: listUsers().map(({ id, name, role, status, createdAt }) => ({ id, name, role, status, createdAt })) });
    return;
  }

  // 以下端点均需认证
  const actor = requireAuth(req);

  if (method === 'GET' && path === '/api/v1/assets') {
    // 红队 V5：agent 令牌只看到自己资产范围内的资产（human/Web 会话全量）
    const assets = filterAssetsForActor(actor.actor, listAssets());
    sendJson(res, 200, { assets, count: assets.length });
    return;
  }

  if (method === 'GET' && path.startsWith('/api/v1/assets/')) {
    const name = decodeURIComponent(path.split('/')[4] ?? '');
    assertAssetVisible(actor.actor, name);
    sendJson(res, 200, getAsset(name));
    return;
  }

  if (method === 'GET' && path === '/api/v1/actions') {
    const status = url.searchParams.get('status') ?? undefined;
    const actorFilter = url.searchParams.get('actor') ?? undefined; // "我的"视图：按创建者过滤（红队 U5：human 用户名或 agent 名）
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const page = listActions({ status: status as never, actor: actorFilter, limit, scopePatterns: agentOrNull(actor.actor)?.assetPatterns });
    sendJson(res, 200, page);
    return;
  }

  // 创建行动（REST 权威接口补全）：Bearer actor 或 Web 会话均可；风险引擎照常裁决
  if (method === 'POST' && path === '/api/v1/actions') {
    const body = (await readBody(req)) as {
      command?: unknown; target?: unknown; reason?: unknown;
      riskHint?: unknown; rollback?: unknown; dryRun?: unknown;
    };
    if (typeof body.command !== 'string' || body.command.trim() === '') {
      sendJson(res, 400, { error: 'command 必填', type: ERROR_CODES.ACTION_INVALID });
      return;
    }
    const { createAction } = await import('../services/actions');
    const result = await createAction({
      command: body.command,
      target: typeof body.target === 'string' && body.target !== '' ? body.target : undefined,
      reason: typeof body.reason === 'string' && body.reason !== '' ? body.reason : undefined,
      riskHint: body.riskHint === 'low' || body.riskHint === 'medium' || body.riskHint === 'high' ? body.riskHint : undefined,
      rollback: typeof body.rollback === 'string' && body.rollback !== '' ? body.rollback : undefined,
      dryRun: body.dryRun === true,
      actor: actor.actor,
    });
    broadcastEvent({ event: 'action-created', actionId: result.action.id, by: actor.actor.id });
    sendJson(res, 201, result);
    return;
  }

  if (method === 'GET' && path.startsWith('/api/v1/actions/') && !path.endsWith('/approve') && !path.endsWith('/reject')) {
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    const found = getAction(id);
    assertActionVisible(actor.actor, found);
    sendJson(res, 200, found);
    return;
  }

  // 行动审批（approver+；委托行动状态机，serve 不持有状态）
  if (method === 'POST' && path.startsWith('/api/v1/actions/') && path.endsWith('/approve')) {
    const auth = requireCapability(req, 'action:approve');
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    const result = await approveAction(id, auth.actor);
    broadcastEvent({ event: 'action-approved', actionId: id, by: auth.actor.id });
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && path.startsWith('/api/v1/actions/') && path.endsWith('/reject')) {
    const auth = requireCapability(req, 'action:approve');
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    const body = (await readBody(req)) as { note?: unknown };
    const action = rejectAction(id, auth.actor, typeof body.note === 'string' && body.note !== '' ? body.note : undefined);
    broadcastEvent({ event: 'action-rejected', actionId: id, by: auth.actor.id });
    sendJson(res, 200, { action });
    return;
  }

  if (method === 'GET' && path === '/api/v1/services') {
    // 红队 V5：agent 只看到挂有范围内资产的服务（拓扑可见性与资产范围一致）
    sendJson(res, 200, { services: listServicesScoped(agentOrNull(actor.actor)?.assetPatterns) });
    return;
  }

  if (method === 'GET' && path === '/api/v1/audit/verify') {
    const result = verifyAuditChain();
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  // ── 告警总线端点（spec/alert-bus）──

  if (method === 'POST' && path === '/api/v1/alerts') {
    // 红队 V7：alerts:write 只属于 Web 会话角色（approver/admin）——
    // agent 令牌无角色能力集，投递告警一律 403（防止注入伪造告警制造告警疲劳）
    requireCapability(req, 'alerts:write');
    const body = await readBody(req);
    const parsed = detectAndParse(body);
    if (parsed.length === 0) {
      sendJson(res, 400, { error: '无法识别的告警格式（支持 Alertmanager/Zabbix/skyport 原生）' });
      return;
    }
    const results = parsed.map((p) => ingestAlert(p));
    broadcastEvent({ event: 'alerts-ingested', count: results.length });
    sendJson(res, 201, { ingested: results.length, alerts: results.map((r) => ({ id: r.alert.id, created: r.created })) });
    return;
  }

  if (method === 'GET' && path === '/api/v1/alerts') {
    const status = url.searchParams.get('status') ?? undefined;
    sendJson(res, 200, { alerts: listAlerts(status as never) });
    return;
  }

  if (method === 'GET' && path === '/api/v1/alerts/stats') {
    sendJson(res, 200, getAlertStats());
    return;
  }

  if (method === 'PATCH' && path.startsWith('/api/v1/alerts/') && path.endsWith('/ack')) {
    requireCapability(req, 'alerts:write');
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    sendJson(res, 200, ackAlert(decodeURIComponent(id)));
    return;
  }

  if (method === 'PATCH' && path.startsWith('/api/v1/alerts/') && path.endsWith('/close')) {
    requireCapability(req, 'alerts:write');
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    sendJson(res, 200, closeAlert(decodeURIComponent(id)));
    return;
  }

  if (method === 'GET' && path === '/api/v1/whoami') {
    sendJson(res, 200, { actor: actor.actor, user: actor.user });
    return;
  }

  // ── 态势包端点（v0.4 知识层）──

  if (method === 'GET' && path.startsWith('/api/v1/context/') && path.endsWith('/summary')) {
    const assetName = decodeURIComponent(path.split('/')[4] ?? '');
    assertAssetVisible(actor.actor, assetName);
    const pack = buildContextPack(assetName);
    sendJson(res, 200, summarizeContextPack(pack));
    return;
  }

  if (method === 'GET' && path.startsWith('/api/v1/context/')) {
    const assetName = decodeURIComponent(path.split('/')[4] ?? '');
    assertAssetVisible(actor.actor, assetName);
    sendJson(res, 200, buildContextPack(assetName));
    return;
  }

  // ── Token 用量看板（v0.5/v0.7）──
  if (method === 'GET' && path === '/api/v1/usage/summary') {
    const { getUsageSummary } = await import('../services/usage');
    const hours = Number(url.searchParams.get('hours') ?? '24');
    sendJson(res, 200, getUsageSummary(hours));
    return;
  }

  // ── 插件管理（v0.5/v0.7）──
  if (method === 'GET' && path === '/api/v1/plugins') {
    const { listPlugins } = await import('../services/plugins');
    sendJson(res, 200, { plugins: listPlugins() });
    return;
  }

  // ── 基线查询（v0.4/v0.7）──
  if (method === 'GET' && path.startsWith('/api/v1/baselines/')) {
    const { getBaselines } = await import('../services/baseline');
    const assetName = decodeURIComponent(path.split('/')[3] ?? '');
    const { getAsset } = await import('../services/assets');
    const asset = getAsset(assetName);
    sendJson(res, 200, { baselines: getBaselines(asset.id) });
    return;
  }

  // ── Analyzer 注册表（v0.5/v0.7）──
  if (method === 'GET' && path === '/api/v1/analyzers') {
    const { listAnalyzers } = await import('../services/analyzers');
    sendJson(res, 200, { analyzers: listAnalyzers() });
    return;
  }

  // ── 剧本列表（v0.6/v0.7）──
  if (method === 'GET' && path === '/api/v1/playbooks') {
    const { BUILTIN_PLAYBOOKS } = await import('../services/playbook');
    sendJson(res, 200, { playbooks: BUILTIN_PLAYBOOKS.map((p) => ({ name: p.name, description: p.description, mode: p.mode, stepCount: p.steps.length })) });
    return;
  }


  // ── 治理月报 + 交接班（v0.7）──
  if (method === 'GET' && path === '/api/v1/governance/report') {
    const { generateReport } = await import('../services/governance');
    const hours = Number(url.searchParams.get('hours') ?? '720');
    sendJson(res, 200, generateReport(hours));
    return;
  }

  if (method === 'POST' && path === '/api/v1/handover') {
    const { createHandover } = await import('../services/governance');
    const body = (await readBody(req)) as { notes?: string };
    sendJson(res, 200, createHandover(body.notes ?? ''));
    return;
  }

  sendJson(res, 404, { error: `Not found: ${method} ${path}` });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}
