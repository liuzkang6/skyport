/**
 * MCP 适配器（PRD 接口层）：把 skyport REST API 翻译为 MCP 工具调用。
 * 零业务逻辑——所有能力在 REST 层实现一次，此处只做协议翻译。
 * 运行：skyport mcp（stdio 模式，供 MCP 客户端如 ZCode 连接）。
 * 红队 V6：令牌经 SKYPORT_API_KEY 提供，与 REST 同源校验（resolveActorWithSessions）；
 * agent 令牌的读面按其资产范围过滤（read-scope，与 REST 读端点一致）。
 */
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
import { rootLogger } from '../logger/logger';
import { getConfig } from '../config/config';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { listAssets, getAsset } from '../services/assets';
import { listActions, getAction, getActionEvents } from '../services/action-queries';
import { listServicesScoped, getBlastRadius } from '../services/cmdb';
import { verifyAuditChain } from '../services/audit-chain';
import { resolveActorWithSessions } from '../services/credentials';
import { agentOrNull, assertActionVisible, assertAssetVisible, filterAssetsForActor } from '../services/read-scope';
import type { ActorRef } from '../services/agents';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly McpTool[] = [
  {
    name: 'skyport_list_assets',
    description: 'List all registered assets (hosts, clusters, cloud accounts)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skyport_get_asset',
    description: 'Get details of a specific asset by name or ID',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Asset name or ID' } },
      required: ['target'],
    },
  },
  {
    name: 'skyport_list_actions',
    description: 'List actions with optional status filter',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', description: 'Filter by status (pending/success/failed/etc)' } },
    },
  },
  {
    name: 'skyport_get_action',
    description: 'Get details of a specific action including events and execution result',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Action ID' } },
      required: ['id'],
    },
  },
  {
    name: 'skyport_list_services',
    description: 'List all registered services from CMDB',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skyport_blast_radius',
    description: 'Get blast radius (affected services) for an asset',
    inputSchema: {
      type: 'object',
      properties: { asset: { type: 'string', description: 'Asset name or ID' } },
      required: ['asset'],
    },
  },
  {
    name: 'skyport_audit_verify',
    description: 'Verify audit chain integrity',
    inputSchema: { type: 'object', properties: {} },
  },
];

/**
 * 启动 MCP 服务器（stdio 模式）。
 * 红队 V6：无令牌/令牌无效直接拒绝启动——MCP 不再是绕过 REST 认证层的旁门。
 * 令牌来源 SKYPORT_API_KEY（config 透传），与 REST Bearer 同源校验。
 */
export function startMcpServer(): void {
  const token = getConfig().apiKey;
  if (token === undefined || token === '') {
    throw createError(ERROR_CODES.AUTH_REQUIRED, 'MCP 适配器需要令牌：设置 SKYPORT_API_KEY（skp_/sks_，与 REST 同源校验）后再启动', { context: {} });
  }
  const actor = resolveActorWithSessions(token); // 无效/过期/吊销在此抛错，进程不进入服务循环
  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    if (line.trim().length === 0) return;
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = handleRequest(request, actor);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      rootLogger.warn('MCP 请求解析失败', { error: error instanceof Error ? error.message : String(error) });
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });

  rootLogger.info('MCP 适配器启动（stdio）', { tools: TOOLS.length, actor: `${actor.type}:${actor.name}` });
}

function handleRequest(request: JsonRpcRequest, actor?: ActorRef): JsonRpcResponse {
  try {
    switch (request.method) {
      case 'initialize':
        return ok(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'skyport-mcp', version: pkg.version },
        });

      case 'tools/list':
        return ok(request.id, { tools: TOOLS });

      case 'tools/call': {
        if (actor === undefined) {
          return err(request.id, -32001, '未认证：MCP 工具调用需要令牌（SKYPORT_API_KEY）');
        }
        const name = request.params?.name as string;
        const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
        const result = callTool(name, args, actor);
        return ok(request.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      }

      default:
        return err(request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    if (isSkyportError(error)) {
      return err(request.id, -32000, `${error.type}: ${error.message}`);
    }
    return err(request.id, -32603, error instanceof Error ? error.message : 'Internal error');
  }
}

/** 工具调用统一带 actor（红队 V6/V5）：agent 令牌的读面与 REST 读端点同一套范围约束 */
function callTool(name: string, args: Record<string, unknown>, actor: ActorRef): unknown {
  switch (name) {
    case 'skyport_list_assets':
      return filterAssetsForActor(actor, listAssets());

    case 'skyport_get_asset':
      assertAssetVisible(actor, String(args.target));
      return getAsset(String(args.target));

    case 'skyport_list_actions':
      return listActions({ status: args.status as never, scopePatterns: agentOrNull(actor)?.assetPatterns });

    case 'skyport_get_action': {
      const id = String(args.id);
      const action = getAction(id);
      assertActionVisible(actor, action);
      return { action, events: getActionEvents(id) };
    }

    case 'skyport_list_services':
      return listServicesScoped(agentOrNull(actor)?.assetPatterns);

    case 'skyport_blast_radius':
      assertAssetVisible(actor, String(args.asset));
      return getBlastRadius(String(args.asset));

    case 'skyport_audit_verify':
      return verifyAuditChain();

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 测试导出：直接测 handleRequest 不走 stdio（actor 由测试显式提供或省略以验证拒绝） */
export { handleRequest as handleRequestForTest };
