import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { createRoleInstance, getRoleSystemPrompt, listRoleInstances, ROLE_TEMPLATES } from './roles';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-roles-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('四角色制（v0.5 智能层）', () => {
  it('四个模板定义齐全，权限递增', () => {
    expect(ROLE_TEMPLATES.patroller.riskCeiling).toBe('low');
    expect(ROLE_TEMPLATES.investigator.riskCeiling).toBe('low');
    expect(ROLE_TEMPLATES.operator.riskCeiling).toBe('medium');
    expect(ROLE_TEMPLATES.reviewer.riskCeiling).toBe('low');

    // 巡查员有自动执行
    expect(ROLE_TEMPLATES.patroller.autoExecLow).toBe(true);
    // 处置员没有自动执行
    expect(ROLE_TEMPLATES.operator.autoExecLow).toBe(false);
    // 调查员是注入防御关键：只读
    expect(ROLE_TEMPLATES.investigator.systemHint).toContain('只读');
    // 审查员是注入探测器
    expect(ROLE_TEMPLATES.reviewer.systemHint).toContain('注入探测器');
  });

  it('创建巡查员实例：agent+刷新令牌+会话令牌全链路', () => {
    const instance = createRoleInstance('patroller');
    expect(instance.role).toBe('patroller');
    expect(instance.agent.name).toContain('role-patroller-');
    expect(instance.refreshToken).toMatch(/^skr_/);
    expect(instance.sessionToken).toMatch(/^sks_/);
    expect(instance.template.displayName).toBe('巡查员');
  });

  it('创建调查员实例：风险上限 low（注入隔离）', () => {
    const instance = createRoleInstance('investigator');
    expect(instance.agent.riskCeiling).toBe('low');
  });

  it('创建处置员实例：风险上限 medium', () => {
    const instance = createRoleInstance('operator');
    expect(instance.agent.riskCeiling).toBe('medium');
  });

  it('创建审查员实例：模型档位 cross-check', () => {
    const instance = createRoleInstance('reviewer');
    expect(instance.template.modelTier).toBe('cross-check');
  });

  it('自定义资产范围', () => {
    const instance = createRoleInstance('operator', 'prod-*');
    expect(instance.agent.assetPatterns).toContain('prod-*');
  });

  it('角色实例列表', () => {
    createRoleInstance('patroller');
    createRoleInstance('operator');
    const list = listRoleInstances();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((r) => r.role === 'patroller')).toBe(true);
    expect(list.some((r) => r.role === 'operator')).toBe(true);
  });

  it('获取系统提示词', () => {
    const prompt = getRoleSystemPrompt('investigator');
    expect(prompt).toContain('调查员');
    expect(prompt).toContain('态势包');
  });

  it('失败路径-未知角色 → AGENT_INVALID', () => {
    try {
      createRoleInstance('hacker' as never);
      throw new Error('应抛错');
    } catch (e) {
      expect(isSkyportError(e)).toBe(true);
      if (isSkyportError(e)) expect(e.type).toBe('SKYPORT_AGENT_INVALID');
    }
  });
});
