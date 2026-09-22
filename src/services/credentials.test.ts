import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { createAgent } from './agents';
import {
  issueRefreshToken,
  listSessions,
  loginWithRefreshToken,
  resolveActorWithSessions,
  revokeSession,
  rotateRefreshToken,
  verifySessionToken,
} from './credentials';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-cred-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

function cap(fn: () => unknown): string {
  try { fn(); } catch (e) { if (isSkyportError(e)) return e.type; throw e; }
  throw new Error('应抛错');
}

describe('凭证三层（spec/agent-credentials）', () => {
  it('正常路径：issue → login → verify 全链路', () => {
    const issued = createAgent({ name: 'test', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const skr = issueRefreshToken(issued.agent.id);
    expect(skr).toMatch(/^skr_[0-9a-f]{64}$/);

    const session = loginWithRefreshToken(skr);
    expect(session.token).toMatch(/^sks_[0-9a-f]{32}$/);
    expect(session.agentName).toBe('test');

    const actor = verifySessionToken(session.token);
    expect(actor.type).toBe('agent');
    expect(actor.name).toBe('test');
  });

  it('失败路径-无效刷新令牌 → PERMISSION_DENIED', () => {
    expect(cap(() => loginWithRefreshToken('skr_invalid'))).toBe('SKYPORT_PERMISSION_DENIED');
  });

  it('失败路径-过期会话令牌 → PERMISSION_DENIED', () => {
    const issued = createAgent({ name: 'exp', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const skr = issueRefreshToken(issued.agent.id);
    const session = loginWithRefreshToken(skr);
    // 直改库让会话过期
    getDb().prepare('UPDATE agent_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(new Date(Date.now() - 1000).toISOString(), require('node:crypto').createHash('sha256').update(session.token).digest('hex'));
    expect(cap(() => verifySessionToken(session.token))).toBe('SKYPORT_PERMISSION_DENIED');
  });

  it('轮换：rotate 后旧 skr_ 失效，新 skr_ 可用', () => {
    const issued = createAgent({ name: 'rot', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const oldSkr = issueRefreshToken(issued.agent.id);
    const { token: newSkr } = rotateRefreshToken('rot');
    expect(cap(() => loginWithRefreshToken(oldSkr))).toBe('SKYPORT_PERMISSION_DENIED');
    expect(loginWithRefreshToken(newSkr).agentName).toBe('rot');
  });

  it('会话列表与吊销', () => {
    const issued = createAgent({ name: 'ses', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const skr = issueRefreshToken(issued.agent.id);
    const session = loginWithRefreshToken(skr); // 创建会话并保存 token
    const sessions = listSessions('ses');
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    revokeSession(sessions[0]!.id);
    // 用原始 token 验证（已被吊销的那个）
    expect(cap(() => verifySessionToken(session.token))).toBe('SKYPORT_PERMISSION_DENIED');
  });

  it('resolveActorWithSessions：sks_ 走会话路径，skp_ 走旧路径', () => {
    const issued = createAgent({ name: 'multi', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const skr = issueRefreshToken(issued.agent.id);
    const session = loginWithRefreshToken(skr);
    const actor = resolveActorWithSessions(session.token);
    expect(actor.type).toBe('agent');
    expect(actor.name).toBe('multi');
  });

  it('agent 吊销后会话立即失效', () => {
    const issued = createAgent({ name: 'rev', assetPatterns: ['*'], riskCeiling: 'medium', autoExecLow: false });
    const skr = issueRefreshToken(issued.agent.id);
    const session = loginWithRefreshToken(skr);
    getDb().prepare('UPDATE agents SET status = ? WHERE id = ?').run('revoked', issued.agent.id);
    expect(cap(() => verifySessionToken(session.token))).toBe('SKYPORT_PERMISSION_DENIED');
  });
});
