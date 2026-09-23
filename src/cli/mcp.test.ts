import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { addAsset } from '../services/assets';
import { createAgent, type ActorRef } from '../services/agents';
import { handleRequestForTest } from './mcp';

/** 红队 V6：工具调用一律带认证 actor（无令牌 → -32001 拒绝） */
function humanActor(): ActorRef {
  return { type: 'human', id: 'tester', name: 'tester' };
}

function agentActor(patterns: string[]): ActorRef {
  const issued = createAgent({ name: `mcp-${patterns.join('_')}`, assetPatterns: patterns, riskCeiling: 'low', autoExecLow: false });
  return { type: 'agent', id: issued.agent.id, name: issued.agent.name };
}

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

  it('tools/call 无 actor → -32001 拒绝（红队 V6：不再默认放行）', () => {
    const res = handleRequestForTest({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'skyport_list_assets', arguments: {} },
    });
    expect(res.error?.code).toBe(-32001);
  });

  it('tools/call skyport_list_assets：返回资产', () => {
    addAsset({ name: 'mcp-test', type: 'host', addr: '127.0.0.1:22', connectMode: 'local' });
    const res = handleRequestForTest(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skyport_list_assets', arguments: {} } },
      humanActor(),
    );
    const text = (res.result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain('mcp-test');
  });

  it('tools/call skyport_get_asset：返回单个资产', () => {
    addAsset({ name: 'single', type: 'host', addr: '10.0.0.1', connectMode: 'local' });
    const res = handleRequestForTest(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'skyport_get_asset', arguments: { target: 'single' } } },
      humanActor(),
    );
    const text = (res.result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain('single');
  });

  it('读侧范围（红队 V5/V6）：t1* agent 只见 t1；范围外 get_asset 被拒', () => {
    addAsset({ name: 't1', type: 'host', addr: '127.0.0.1:22', connectMode: 'local' });
    addAsset({ name: 't9', type: 'host', addr: '127.0.0.1:29', connectMode: 'local' });
    const actor = agentActor(['t1*']);
    const list = handleRequestForTest(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'skyport_list_assets', arguments: {} } },
      actor,
    );
    const text = (list.result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain('t1');
    expect(text).not.toContain('t9');

    const denied = handleRequestForTest(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'skyport_get_asset', arguments: { target: 't9' } } },
      actor,
    );
    expect(denied.error).toBeDefined();
    expect(denied.error?.message).toContain('SKYPORT_PERMISSION_DENIED');
  });

  it('tools/call 未知工具 → 错误响应', () => {
    const res = handleRequestForTest(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nonexistent', arguments: {} } },
      humanActor(),
    );
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain('Unknown tool');
  });

  it('未知 method → -32601', () => {
    const res = handleRequestForTest({ jsonrpc: '2.0', id: 6, method: 'invalid/method' });
    expect(res.error?.code).toBe(-32601);
  });
});
