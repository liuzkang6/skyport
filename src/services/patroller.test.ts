import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { chatComplete } from './llm';
import {
  PATROLLER_AGENT_NAME,
  ensurePatrollerActor,
  parseDecision,
  reviewProposal,
  runPatrollerSweep,
} from './patroller';

vi.mock('./llm', () => ({ chatComplete: vi.fn() }));

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-patroller-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  // 巡查员低危命令自动执行（role autoExecLow + 策略双开关）
  const policyFile = join(tempDir, 'skyport.policy.json');
  writeFileSync(policyFile, JSON.stringify({ autoExecLowRisk: true }));
  process.env.SKYPORT_POLICY_PATH = policyFile;
  resetConfigCache();
  vi.mocked(chatComplete).mockReset();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  delete process.env.SKYPORT_POLICY_PATH;
  resetConfigCache();
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('巡查员座位（spec/llm-seat）', () => {
  it('系统 agent 自动开通，幂等', () => {
    const first = ensurePatrollerActor();
    expect(first.name).toBe(PATROLLER_AGENT_NAME);
    expect(ensurePatrollerActor().id).toBe(first.id);
  });

  it('决策解析：JSON 围栏容错、字段缺失的提案忽略、非 JSON 报错', () => {
    expect(parseDecision('{"proposals":[],"note":"正常"}')).toEqual({ proposals: [], note: '正常' });
    expect(parseDecision('```json\n{"proposals":[{"command":"df -h","target":"t1","reason":"磁盘"}],"note":"查盘"}\n```').proposals).toHaveLength(1);
    // command 缺失的提案忽略
    const mixed = parseDecision('{"proposals":[{"target":"t1"},{"command":"uptime","target":"t2","reason":"r"}],"note":"n"}');
    expect(mixed.proposals).toHaveLength(1);
    expect(mixed.proposals[0]!.command).toBe('uptime');
    // 格式整体不对：不炸，返回空提案
    expect(parseDecision('{"proposals":"nope","note":"x"}').proposals).toHaveLength(0);
    expect(() => parseDecision('完全没有 JSON')).toThrow();
  });

  it('白名单复核：只读命令头放行，危险头/片段拒绝', () => {
    expect(reviewProposal({ command: 'df -h /', target: 't1', reason: 'r' })).toBeUndefined();
    expect(reviewProposal({ command: 'journalctl -u nginx -n 50', target: 't1', reason: 'r' })).toBeUndefined();
    expect(reviewProposal({ command: 'rm -rf /tmp/x', target: 't1', reason: 'r' })).toContain('白名单');
    expect(reviewProposal({ command: 'cat /etc/passwd > /tmp/steal', target: 't1', reason: 'r' })).toContain('危险片段');
    expect(reviewProposal({ command: 'echo hacked | bash', target: 't1', reason: 'r' })).toContain('白名单');
  });

  it('全链路（mock LLM）：告警简报 → 决策 → 只读提案建行动并自动执行；危险提案被拒', async () => {
    // 造一条开放告警（观测输入）与目标资产
    const now = new Date().toISOString();
    // local 执行模式：提案命令在本机真跑（df -h / 在测试机上必然成功）
    getDb().prepare(`INSERT INTO assets (id, name, type, addr, connect_mode, status, created_at, updated_at)
      VALUES ('ast_p1', 't1', 'host', 'local', 'local', 'unknown', ?, ?)`).run(now, now);
    getDb().prepare(`INSERT INTO alerts (id, event, resource, severity, status, origin, dedup_key, timestamp, created_at, updated_at)
      VALUES ('alt_p1', 'DiskFull', 't1', 'critical', 'open', 'test', 'dk_p1', ?, ?, ?)`).run(now, now, now);

    vi.mocked(chatComplete).mockResolvedValue({
      content: JSON.stringify({
        proposals: [
          { command: 'df -h /', target: 't1', reason: '磁盘告警确认使用率' },
          { command: 'rm -rf /tmp/evil', target: 't1', reason: '恶意提案（应被白名单拒绝）' },
        ],
        note: '磁盘告警需确认',
      }),
      model: 'GLM-5.3-Flash', promptTokens: 100, completionTokens: 20, durationMs: 500, injectionsDetected: [],
    });

    const result = await runPatrollerSweep({ assetName: undefined, severity: undefined });

    // 提示词包含巡查员角色与观测简报（告警事件名）
    expect(chatComplete).toHaveBeenCalledTimes(1);
    const messages = vi.mocked(chatComplete).mock.calls[0]![0];
    expect(messages[0]!.content).toContain('巡查员');
    expect(messages[1]!.content).toContain('DiskFull');
    // 只读提案被接受并建行动（低危自动执行 → success/executing）；危险提案被白名单拒绝
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.command).toBe('df -h /');
    expect(result.proposals[0]!.actionId).toMatch(/^act_/);
    expect(['success', 'executing']).toContain(result.proposals[0]!.status);
    // 模型与 token 摘要来自 LLM 返回（usage 记账在 llm.test.ts 单独验证——mock 边界外）
    expect(result.modelsUsed).toBe('GLM-5.3-Flash');
    expect(result.promptTokens).toBe(100);
  });

  it('无异常无提案：LLM 空提案 → 零行动、零报错', async () => {
    vi.mocked(chatComplete).mockResolvedValue({
      content: '{"proposals":[],"note":"一切正常"}',
      model: 'GLM-5.3-Flash', promptTokens: 50, completionTokens: 5, durationMs: 200, injectionsDetected: [],
    });
    const result = await runPatrollerSweep({ assetName: undefined, severity: undefined });
    expect(result.proposals).toHaveLength(0);
    expect(result.note).toBe('一切正常');
    const actions = (getDb().prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number }).n;
    expect(actions).toBe(0);
  });

  it('LLM 未配置模型时上抛可读错误', async () => {
    vi.mocked(chatComplete).mockRejectedValue(new Error('未配置任何模型（设置 → 模型配置，或 POST /api/v1/models）'));
    await expect(runPatrollerSweep({ assetName: undefined, severity: undefined })).rejects.toThrow('未配置任何模型');
  });
});
