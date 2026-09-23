import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import type { UserRole } from './users';
import {
  can, createUser, issueWebSession, listUsers, removeUser, revokeWebSession,
  setUserStatus, verifyLogin, verifyWebSession, ROLE_CAPABILITIES,
} from './users';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-users-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('用户与角色四分（spec/webui）', () => {
  it('角色能力集严格递增 viewer ⊂ operator ⊂ approver ⊂ admin', () => {
    expect(can('viewer', 'read')).toBe(true);
    expect(can('viewer', 'action:create')).toBe(false);
    expect(can('operator', 'action:create')).toBe(true);
    expect(can('operator', 'action:approve')).toBe(false);
    expect(can('approver', 'action:approve')).toBe(true);
    expect(can('approver', 'users:manage')).toBe(false);
    expect(can('admin', 'users:manage')).toBe(true);
    // 集合逐级包含（严格递增的机器证明）
    const ladder: readonly [UserRole, UserRole][] = [
      ['viewer', 'operator'],
      ['operator', 'approver'],
      ['approver', 'admin'],
    ];
    for (const [prevRole, currRole] of ladder) {
      for (const cap of ROLE_CAPABILITIES[prevRole]) expect(ROLE_CAPABILITIES[currRole]).toContain(cap);
    }
  });

  it('创建用户 + 清单不含盐与哈希', () => {
    const user = createUser('alice', 'password8', 'approver');
    expect(user.role).toBe('approver');
    expect(user.status).toBe('active');
    const users = listUsers();
    expect(users.some((u) => u.name === 'alice')).toBe(true);
    const raw = JSON.stringify(users);
    expect(raw).not.toContain('password_salt');
    expect(raw).not.toContain('password_hash');
  });

  it('登录成功返回用户并清零失败计数', () => {
    createUser('bob', 'password8', 'operator');
    const user = verifyLogin('bob', 'password8');
    expect(user.name).toBe('bob');
    expect(user.role).toBe('operator');
  });

  it('失败路径-用户不存在 → PERMISSION_DENIED（统一文案）', () => {
    try {
      verifyLogin('ghost', 'password8');
      throw new Error('应抛错');
    } catch (e) {
      expect(isSkyportError(e)).toBe(true);
      if (isSkyportError(e)) {
        expect(e.type).toBe('SKYPORT_PERMISSION_DENIED');
        expect(e.message).toBe('用户名或密码错误');
      }
    }
  });

  it('失败路径-密码错误 → PERMISSION_DENIED 同一文案（防枚举）', () => {
    createUser('carol', 'password8', 'viewer');
    const msgA = (() => {
      try {
        verifyLogin('ghost', 'x'.repeat(8));
      } catch (e) {
        return e instanceof Error ? e.message : '';
      }
    })();
    const msgB = (() => {
      try {
        verifyLogin('carol', 'wrongpass');
      } catch (e) {
        return e instanceof Error ? e.message : '';
      }
    })();
    expect(msgA).toBe('用户名或密码错误');
    expect(msgB).toBe(msgA);
  });

  it('失败路径-连续 5 次失败锁定（USER_LOCKED 可重试），锁定中正确密码也拒绝', () => {
    createUser('dave', 'password8', 'viewer');
    for (let i = 0; i < 5; i += 1) {
      expect(() => verifyLogin('dave', 'wrongpass')).toThrow();
    }
    try {
      verifyLogin('dave', 'password8');
      throw new Error('应抛错');
    } catch (e) {
      expect(isSkyportError(e)).toBe(true);
      if (isSkyportError(e)) {
        expect(e.type).toBe('SKYPORT_USER_LOCKED');
        expect(e.retryable).toBe(true);
      }
    }
  });

  it('失败路径-重名 → USER_DUPLICATE_NAME', () => {
    createUser('erin', 'password8', 'viewer');
    try {
      createUser('erin', 'password8', 'viewer');
      throw new Error('应抛错');
    } catch (e) {
      expect(isSkyportError(e)).toBe(true);
      if (isSkyportError(e)) expect(e.type).toBe('SKYPORT_USER_DUPLICATE_NAME');
    }
  });

  it('失败路径-非法用户名/弱密码/非法角色 → USER_INVALID', () => {
    const expectInvalid = (fn: () => unknown) => {
      try {
        fn();
        throw new Error('应抛错');
      } catch (e) {
        expect(isSkyportError(e)).toBe(true);
        if (isSkyportError(e)) expect(e.type).toBe('SKYPORT_USER_INVALID');
      }
    };
    expectInvalid(() => createUser('Bad Name', 'password8', 'viewer'));
    expectInvalid(() => createUser('ok-name', 'short', 'viewer'));
    expectInvalid(() => createUser('ok-name', 'password8', 'superuser' as never));
  });
});

describe('Web 会话（skw_）', () => {
  it('签发-校验-登出全链路', () => {
    const user = createUser('frank', 'password8', 'admin');
    const session = issueWebSession(user);
    expect(session.token).toMatch(/^skw_/);
    const resolved = verifyWebSession(session.token);
    expect(resolved.id).toBe(user.id);
    expect(resolved.role).toBe('admin');
    revokeWebSession(session.token);
    try {
      verifyWebSession(session.token);
      throw new Error('应抛错');
    } catch (e) {
      expect(isSkyportError(e)).toBe(true);
      if (isSkyportError(e)) expect(e.type).toBe('SKYPORT_PERMISSION_DENIED');
    }
  });

  it('失败路径-无效令牌 → PERMISSION_DENIED', () => {
    try {
      verifyWebSession('skw_not-a-real-token');
      throw new Error('应抛错');
    } catch (e) {
      expect(isSkyportError(e)).toBe(true);
      if (isSkyportError(e)) expect(e.type).toBe('SKYPORT_PERMISSION_DENIED');
    }
  });

  it('停用：立即吊销现有会话，登录被拒（USER_DISABLED）；enable 恢复（红队 V8）', () => {
    createUser('bye-user', 'password8', 'viewer');
    const session = issueWebSession(verifyLogin('bye-user', 'password8'));
    expect(verifyWebSession(session.token).name).toBe('bye-user');

    const disabled = setUserStatus('bye-user', 'disabled');
    expect(disabled.status).toBe('disabled');
    // 停用即吊销会话
    expect(() => verifyWebSession(session.token)).toThrowError();
    // 登录也进不来
    try {
      verifyLogin('bye-user', 'password8');
      expect.unreachable('停用用户不应能登录');
    } catch (error) {
      expect(isSkyportError(error) && error.type === 'SKYPORT_USER_DISABLED').toBe(true);
    }

    const enabled = setUserStatus('bye-user', 'active');
    expect(enabled.status).toBe('active');
    expect(verifyLogin('bye-user', 'password8').name).toBe('bye-user');
  });

  it('删除：用户与会话一并清除；不存在 → USER_NOT_FOUND（红队 V8）', () => {
    createUser('tmp-user', 'password8', 'operator');
    const session = issueWebSession(verifyLogin('tmp-user', 'password8'));
    const removed = removeUser('tmp-user');
    expect(removed.name).toBe('tmp-user');
    expect(listUsers().some((u) => u.name === 'tmp-user')).toBe(false);
    expect(() => verifyWebSession(session.token)).toThrowError();
    expect(() => verifyLogin('tmp-user', 'password8')).toThrowError();

    try {
      removeUser('tmp-user');
      expect.unreachable('已删用户再删应报错');
    } catch (error) {
      expect(isSkyportError(error) && error.type === 'SKYPORT_USER_NOT_FOUND').toBe(true);
    }
  });

  it('失败路径-重复登出幂等（不报错）', () => {
    const user = createUser('grace', 'password8', 'viewer');
    const session = issueWebSession(user);
    revokeWebSession(session.token);
    expect(() => revokeWebSession(session.token)).not.toThrow();
  });
});
