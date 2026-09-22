import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import {
  actorFromKey,
  assertAgentMayCreateAction,
  createAgent,
  getAgent,
  globMatch,
  listAgents,
  requireHumanActor,
  resolveActor,
  setAgentStatus,
} from './agents';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-agents-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

function captureAgentError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isSkyportError(error)) return error.type;
    throw error;
  }
  throw new Error('期望抛出 agent 错误，但它正常返回了');
}

describe('agents 身份与权限', () => {
  it('正常路径：create 签发 skp_ key 一次；库中只存哈希（明文与哈希不同且哈希可反查）', () => {
    const issued = createAgent({ name: 'zcode-ops', assetPatterns: ['prod-*'], riskCeiling: 'medium', autoExecLow: false });
    expect(issued.plaintextKey).toMatch(/^skp_[0-9a-f]{32}$/);
    const row = getDb().prepare('SELECT key_hash FROM agents WHERE id = ?').get(issued.agent.id) as { key_hash: string };
    expect(row.key_hash).not.toContain(issued.plaintextKey);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/); // sha256
    expect(issued.agent.scopes).toEqual(['action:create']);
  });

  it('正常路径：key 可换回身份；错误 key → PERMISSION_DENIED', () => {
    const issued = createAgent({ name: 'a1', assetPatterns: ['*'], riskCeiling: 'high', autoExecLow: true });
    expect(actorFromKey(issued.plaintextKey).name).toBe('a1');
    expect(captureAgentError(() => actorFromKey('skp_deadbeef'))).toBe('SKYPORT_PERMISSION_DENIED');
  });

  it('失败路径-重名：AGENT_DUPLICATE_NAME', () => {
    createAgent({ name: 'dup', assetPatterns: ['*'], riskCeiling: 'low', autoExecLow: false });
    expect(
      captureAgentError(() => createAgent({ name: 'dup', assetPatterns: ['*'], riskCeiling: 'low', autoExecLow: false })),
    ).toBe('SKYPORT_AGENT_DUPLICATE_NAME');
  });

  it('三态：paused/revoked 后 key 立即失效；revoked 不可再变更', () => {
    const issued = createAgent({ name: 'a2', assetPatterns: ['*'], riskCeiling: 'high', autoExecLow: false });
    setAgentStatus('a2', 'paused');
    expect(captureAgentError(() => actorFromKey(issued.plaintextKey))).toBe('SKYPORT_PERMISSION_DENIED');
    setAgentStatus('a2', 'active');
    expect(actorFromKey(issued.plaintextKey).name).toBe('a2');
    setAgentStatus('a2', 'revoked');
    expect(captureAgentError(() => actorFromKey(issued.plaintextKey))).toBe('SKYPORT_PERMISSION_DENIED');
    expect(captureAgentError(() => setAgentStatus('a2', 'active'))).toBe('SKYPORT_AGENT_INVALID');
  });

  it('到期：过期 key → PERMISSION_DENIED', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const issued = createAgent({ name: 'expired', assetPatterns: ['*'], riskCeiling: 'high', autoExecLow: false, expiresAt: past });
    expect(captureAgentError(() => actorFromKey(issued.plaintextKey))).toBe('SKYPORT_PERMISSION_DENIED');
  });

  it('审批红线：approve 类操作带 key → PERMISSION_DENIED；无 key → human actor', () => {
    const issued = createAgent({ name: 'a3', assetPatterns: ['*'], riskCeiling: 'high', autoExecLow: false });
    expect(captureAgentError(() => requireHumanActor(issued.plaintextKey))).toBe('SKYPORT_PERMISSION_DENIED');
    const human = requireHumanActor(undefined);
    expect(human.type).toBe('human');
    expect(human.id.length).toBeGreaterThan(0);
    expect(resolveActor(undefined).type).toBe('human');
    expect(resolveActor(issued.plaintextKey).type).toBe('agent');
  });

  it('权限三件套：风险超限 / 资产不在范围 / 无 auto-exec-low → PERMISSION_DENIED；全部满足则放行', () => {
    const agent = createAgent({ name: 'limited', assetPatterns: ['prod-web-*'], riskCeiling: 'low', autoExecLow: false }).agent;
    assertAgentMayCreateAction(agent, 'prod-web-01', 'low', false); // 全满足：直接调用不应抛错
    expect(captureAgentError(() => assertAgentMayCreateAction(agent, 'prod-web-01', 'medium', false))).toBe(
      'SKYPORT_PERMISSION_DENIED',
    );
    expect(captureAgentError(() => assertAgentMayCreateAction(agent, 'db-01', 'low', false))).toBe(
      'SKYPORT_PERMISSION_DENIED',
    );
    expect(captureAgentError(() => assertAgentMayCreateAction(agent, 'prod-web-01', 'low', true))).toBe(
      'SKYPORT_PERMISSION_DENIED',
    );
    const full = createAgent({ name: 'full', assetPatterns: ['*'], riskCeiling: 'high', autoExecLow: true }).agent;
    assertAgentMayCreateAction(full, 'anything', 'high', true); // 全满足：直接调用不应抛错
  });

  it('glob：* 通配与字面量匹配；list/get 正常', () => {
    expect(globMatch('prod-web-*', 'prod-web-01')).toBe(true);
    expect(globMatch('prod-web-*', 'db-01')).toBe(false);
    expect(globMatch('*', 'local')).toBe(true);
    expect(globMatch('local', 'local')).toBe(true);
    createAgent({ name: 'g1', assetPatterns: ['a*'], riskCeiling: 'low', autoExecLow: false });
    expect(listAgents().map((agent) => agent.name)).toContain('g1');
    expect(getAgent('g1').riskCeiling).toBe('low');
    expect(captureAgentError(() => getAgent('ghost'))).toBe('SKYPORT_AGENT_NOT_FOUND');
  });
});
