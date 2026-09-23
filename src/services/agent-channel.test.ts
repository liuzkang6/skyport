import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../config/config';
import {
  dispatchToAsset,
  isAssetChannelConnected,
  listConnectedAssets,
  registerChannel,
  resetChannelsForTest,
  resolveAgentResult,
  unregisterChannel,
  type AgentExecResult,
} from './agent-channel';

beforeEach(() => {
  resetConfigCache();
  resetChannelsForTest();
  process.env.SKYPORT_EXEC_TIMEOUT_MS = '500';
});

afterEach(() => {
  delete process.env.SKYPORT_EXEC_TIMEOUT_MS;
  resetConfigCache();
  resetChannelsForTest();
});

function fakeResult(requestId: string, overrides: Partial<AgentExecResult> = {}): AgentExecResult {
  return {
    requestId,
    ok: true,
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    durationMs: 12,
    timedOut: false,
    ...overrides,
  };
}

describe('agent 反向通道（v0.4 收尾）', () => {
  it('注册后通道在线；断开后离线', () => {
    const sender = () => {};
    registerChannel('t1', sender);
    expect(isAssetChannelConnected('t1')).toBe(true);
    expect(listConnectedAssets()).toContain('t1');

    unregisterChannel('t1', sender);
    expect(isAssetChannelConnected('t1')).toBe(false);
    expect(listConnectedAssets()).not.toContain('t1');
  });

  it('同一资产多连接互为热备：一条断开另一条仍在线', () => {
    const a = () => {};
    const b = () => {};
    registerChannel('t1', a);
    registerChannel('t1', b);
    unregisterChannel('t1', a);
    expect(isAssetChannelConnected('t1')).toBe(true);
  });

  it('下发命令 → agent 回传 → resolve 收到结果', async () => {
    const sent: Record<string, unknown>[][] = [];
    registerChannel('t1', (payload) => {
      sent.push([payload]);
      const requestId = String(payload.requestId);
      // 异步回传（模拟 agent 执行后 POST）
      setTimeout(() => {
        resolveAgentResult(fakeResult(requestId, { stdout: 'hello-from-agent' }));
      }, 10);
    });

    const result = await dispatchToAsset('t1', 'echo hello');

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('hello-from-agent');
    expect(sent[0]?.[0]).toMatchObject({ event: 'exec', command: 'echo hello' });
  });

  it('无在线通道：立即返回失败结果（ok=false）', async () => {
    const result = await dispatchToAsset('t2', 'echo x');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('无在线 agent 通道');
  });

  it('超时未回传：resolve 收到 timedOut 结果', async () => {
    registerChannel('t1', () => { /* 收到但不回传 */ });
    const result = await dispatchToAsset('t1', 'sleep 100');
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('重复/未知 requestId 回传被拒绝', () => {
    expect(resolveAgentResult(fakeResult('nonexistent'))).toBe(false);
  });

  it('send 抛错的连接被当场摘除，不影响其他连接', async () => {
    const bad = () => {
      throw new Error('connection broken');
    };
    registerChannel('t1', bad);
    const good: string[] = [];
    registerChannel('t1', (payload) => {
      good.push(String(payload.requestId));
      setTimeout(() => resolveAgentResult(fakeResult(String(payload.requestId))), 5);
    });

    const result = await dispatchToAsset('t1', 'echo hi');

    expect(result.ok).toBe(true);
    expect(isAssetChannelConnected('t1')).toBe(true); // 好连接还在
  });
});
