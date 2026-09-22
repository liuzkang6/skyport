/**
 * REST API v1（PRD 接口层）：serve 骨架 + 核心端点。
 * 权威接口：所有能力资源化在 REST；MCP 适配器（后续）翻译到此层。
 * 认证：Authorization: Bearer <sks_...|skp_...>（会话令牌或静态 key）。
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

export interface ServeOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
}

export interface ServeResult {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
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
        sendJson(res, error instanceof Error && isSkyportError(error) ? mapErrorToStatus(error.type) : 500, {
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
  if (type.startsWith('SKYPORT_PERMISSION')) return 403;
  if (type.startsWith('SKYPORT_ASSET_NOT') || type.startsWith('SKYPORT_ACTION_NOT') || type.startsWith('SKYPORT_AGENT_NOT')) return 404;
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

/** 认证中间件：无令牌返回 401 */
function requireAuth(req: IncomingMessage): ReturnType<typeof resolveActorWithSessions> {
  const token = extractToken(req);
  if (token === undefined) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '缺少 Authorization: Bearer 令牌', { context: {} });
  }
  return resolveActorWithSessions(token);
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

  // 以下端点均需认证
  const actor = requireAuth(req);

  if (method === 'GET' && path === '/api/v1/assets') {
    const assets = listAssets();
    sendJson(res, 200, { assets, count: assets.length });
    return;
  }

  if (method === 'GET' && path.startsWith('/api/v1/assets/')) {
    const name = decodeURIComponent(path.split('/')[3] ?? '');
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
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    sendJson(res, 200, getAction(id));
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
    const id = path.split('/')[3] ?? '';
    sendJson(res, 200, ackAlert(decodeURIComponent(id)));
    return;
  }

  if (method === 'PATCH' && path.startsWith('/api/v1/alerts/') && path.endsWith('/close')) {
    const id = path.split('/')[3] ?? '';
    sendJson(res, 200, closeAlert(decodeURIComponent(id)));
    return;
  }

  if (method === 'GET' && path === '/api/v1/whoami') {
    sendJson(res, 200, { actor });
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
