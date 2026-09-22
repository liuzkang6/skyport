/**
 * MCP 适配器（PRD 接口层）：把 skyport REST API 翻译为 MCP 工具调用。
 * 零业务逻辑——所有能力在 REST 层实现一次，此处只做协议翻译。
 * 运行：skyport mcp（stdio 模式，供 MCP 客户端如 ZCode 连接）
 */
import { createInterface } from 'node:readline';
import { rootLogger } from '../logger/logger';
import { listAssets, getAsset } from '../services/assets';
import { listActions, getAction, getActionEvents } from '../services/action-queries';
import { listServices, getBlastRadius } from '../services/cmdb';
import { verifyAuditChain } from '../services/audit-chain';
import { isSkyportError } from '../errors/errors';

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

/** 启动 MCP 服务器（stdio 模式） */
export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    if (line.trim().length === 0) return;
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = handleRequest(request);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      rootLogger.warn('MCP 请求解析失败', { error: error instanceof Error ? error.message : String(error) });
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });

  rootLogger.info('MCP 适配器启动（stdio）', { tools: TOOLS.length });
}

function handleRequest(request: JsonRpcRequest): JsonRpcResponse {
  try {
    switch (request.method) {
      case 'initialize':
        return ok(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'skyport-mcp', version: '0.3.0' },
        });

      case 'tools/list':
        return ok(request.id, { tools: TOOLS });

      case 'tools/call': {
        const name = request.params?.name as string;
        const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
        const result = callTool(name, args);
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

function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'skyport_list_assets':
      return listAssets();

    case 'skyport_get_asset':
      return getAsset(String(args.target));

    case 'skyport_list_actions':
      return listActions({ status: args.status as never });

    case 'skyport_get_action': {
      const id = String(args.id);
      return { action: getAction(id), events: getActionEvents(id) };
    }

    case 'skyport_list_services':
      return listServices();

    case 'skyport_blast_radius':
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

/** 测试导出：直接测 handleRequest 不走 stdio */
export { handleRequest as handleRequestForTest };
