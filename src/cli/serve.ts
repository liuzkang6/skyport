/**
 * REST API v1（PRD 接口层）：serve 骨架 + 核心端点。
 * 权威接口：所有能力资源化在 REST；MCP 适配器翻译到此层。
 * 认证双轨（spec/webui）：Authorization: Bearer <sks_|skp_|skr_>（API 消费方）
 * 或 Web 会话 cookie skyport_session=skw_...（浏览器，角色四分门禁）。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { rootLogger } from '../logger/logger';
import { resolveActorWithSessions } from '../services/credentials';
import { listActions, getAction } from '../services/action-queries';
import { listAssets, getAsset } from '../services/assets';
import { listServices } from '../services/cmdb';
import { verifyAuditChain } from '../services/audit-chain';
import { detectAndParse, ingestAlert, listAlerts, ackAlert, closeAlert, getAlertStats } from '../services/alert-bus';
import { buildContextPack, summarizeContextPack } from '../services/context-pack';
import { approveAction, rejectAction } from '../services/actions';
import {
  WEB_SESSION_COOKIE, can, issueWebSession, listUsers, revokeWebSession,
  verifyLogin, verifyWebSession, type User,
} from '../services/users';
import type { ActorRef } from '../services/agents';
import { serveStatic } from './static';

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
  });
}

function mapErrorToStatus(type: string): number {
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
  const user = verifyWebSession(cookieToken);
  return { actor: { type: 'human', id: user.id, name: user.name }, user, cookieToken };
}

/** 认证中间件：无凭证返回 401（PERMISSION_DENIED） */
function requireAuth(req: IncomingMessage): RequestAuth {
  const auth = resolveAuth(req);
  if (auth === undefined) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '缺少认证凭证（Bearer 或会话 cookie）', { context: {} });
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
    sendJson(res, 200, { status: 'ok', version: '0.3.0', timestamp: new Date().toISOString() });
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
    const assets = listAssets();
    sendJson(res, 200, { assets, count: assets.length });
    return;
  }

  if (method === 'GET' && path.startsWith('/api/v1/assets/')) {
    const name = decodeURIComponent(path.split('/')[4] ?? '');
    sendJson(res, 200, getAsset(name));
    return;
  }

  if (method === 'GET' && path === '/api/v1/actions') {
    const status = url.searchParams.get('status') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const page = listActions({ status: status as never, limit });
    sendJson(res, 200, page);
    return;
  }

  if (method === 'GET' && path.startsWith('/api/v1/actions/')) {
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    sendJson(res, 200, getAction(id));
    return;
  }

  // 行动审批（approver+；委托行动状态机，serve 不持有状态）
  if (method === 'POST' && path.startsWith('/api/v1/actions/') && path.endsWith('/approve')) {
    const auth = requireCapability(req, 'action:approve');
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    const result = await approveAction(id, auth.actor);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && path.startsWith('/api/v1/actions/') && path.endsWith('/reject')) {
    const auth = requireCapability(req, 'action:approve');
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    const body = (await readBody(req)) as { note?: unknown };
    const action = rejectAction(id, auth.actor, typeof body.note === 'string' && body.note !== '' ? body.note : undefined);
    sendJson(res, 200, { action });
    return;
  }

  if (method === 'GET' && path === '/api/v1/services') {
    sendJson(res, 200, { services: listServices() });
    return;
  }

  if (method === 'GET' && path === '/api/v1/audit/verify') {
    const result = verifyAuditChain();
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  // ── 告警总线端点（spec/alert-bus）──

  if (method === 'POST' && path === '/api/v1/alerts') {
    if (actor.user !== undefined) requireCapability(req, 'alerts:write');
    const body = await readBody(req);
    const parsed = detectAndParse(body);
    if (parsed.length === 0) {
      sendJson(res, 400, { error: '无法识别的告警格式（支持 Alertmanager/Zabbix/skyport 原生）' });
      return;
    }
    const results = parsed.map((p) => ingestAlert(p));
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
    const pack = buildContextPack(assetName);
    sendJson(res, 200, summarizeContextPack(pack));
    return;
  }

  if (method === 'GET' && path.startsWith('/api/v1/context/')) {
    const assetName = decodeURIComponent(path.split('/')[4] ?? '');
    sendJson(res, 200, buildContextPack(assetName));
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
