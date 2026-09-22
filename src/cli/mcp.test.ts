import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { addAsset } from '../services/assets';
import { handleRequestForTest } from './mcp';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-mcp-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('MCP 适配器', () => {
  it('initialize：返回服务器信息', () => {
    const res = handleRequestForTest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.result).toMatchObject({ serverInfo: { name: 'skyport-mcp' } });
  });

  it('tools/list：返回 ≥ 7 个工具', () => {
    const res = handleRequestForTest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res.result as { tools: { name: string }[] }).tools;
    expect(tools.length).toBeGreaterThanOrEqual(7);
    expect(tools.map((t) => t.name)).toContain('skyport_list_assets');
    expect(tools.map((t) => t.name)).toContain('skyport_blast_radius');
    expect(tools.map((t) => t.name)).toContain('skyport_audit_verify');
  });

  it('tools/call skyport_list_assets：返回资产', () => {
    addAsset({ name: 'mcp-test', type: 'host', addr: '127.0.0.1:22', connectMode: 'local' });
    const res = handleRequestForTest({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'skyport_list_assets', arguments: {} },
    });
    const text = (res.result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain('mcp-test');
  });

  it('tools/call skyport_get_asset：返回单个资产', () => {
    addAsset({ name: 'single', type: 'host', addr: '10.0.0.1', connectMode: 'local' });
    const res = handleRequestForTest({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'skyport_get_asset', arguments: { target: 'single' } },
    });
    const text = (res.result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain('single');
  });

  it('tools/call 未知工具 → 错误响应', () => {
    const res = handleRequestForTest({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain('Unknown tool');
  });

  it('未知 method → -32601', () => {
    const res = handleRequestForTest({ jsonrpc: '2.0', id: 6, method: 'invalid/method' });
    expect(res.error?.code).toBe(-32601);
  });
});
