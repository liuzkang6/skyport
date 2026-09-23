/**
 * 四角色制（PRD §2 常驻角色制）：分工即治理单元。
 * 巡查员（定时巡逻/廉价模型/只读）、调查员（态势包消费/诊断/上限 low）、
 * 处置员（处置提案/上限 medium）、审查员（方案复核/咨询性裁决/异模型防互捧）。
 * 角色创建 = 一条命令生成预配置的 agent + 刷新令牌 + 会话。
 */
import { createError, ERROR_CODES } from '../errors/errors';
import { createAgent, listAgents, type Agent } from './agents';
import { issueRefreshToken, loginWithRefreshToken } from './credentials';

export type RoleName = 'patroller' | 'investigator' | 'operator' | 'reviewer';

export interface RoleTemplate {
  readonly role: RoleName;
  readonly displayName: string;
  readonly description: string;
  readonly riskCeiling: 'low' | 'medium' | 'high';
  readonly autoExecLow: boolean;
  readonly scopes: readonly string[];
  readonly defaultAssets: string;
  readonly modelTier: 'cheap' | 'standard' | 'strong' | 'cross-check';
  readonly systemHint: string;
}

export const ROLE_TEMPLATES: Readonly<Record<RoleName, RoleTemplate>> = {
  patroller: {
    role: 'patroller',
    displayName: '巡查员',
    description: '定时巡逻，只读检查，零打扰（L2 自动执行低危只读命令）',
    riskCeiling: 'low',
    autoExecLow: true,
    scopes: ['action:create', 'auto-exec-low'],
    defaultAssets: '*',
    modelTier: 'cheap',
    systemHint: '你是运维巡查员。你的任务是定时巡逻所有资产，执行只读检查命令（uptime/df/free），发现异常记录并汇报。你只能执行低风险只读命令。',
  },
  investigator: {
    role: 'investigator',
    displayName: '调查员',
    description: '接收态势包、诊断根因、提只读探查提案（注入防御的关键权限隔离）',
    riskCeiling: 'low',
    autoExecLow: true,
    scopes: ['action:create', 'auto-exec-low'],
    defaultAssets: '*',
    modelTier: 'strong',
    systemHint: '你是运维调查员。你收到态势包（Context Pack）后进行根因诊断。区分"已确认"与"待验证"假设，用两个独立来源交叉验证。你只能提案只读命令。',
  },
  operator: {
    role: 'operator',
    displayName: '处置员',
    description: '提交带回滚声明的处置方案（风险上限 medium+）',
    riskCeiling: 'medium',
    autoExecLow: false,
    scopes: ['action:create'],
    defaultAssets: '*',
    modelTier: 'strong',
    systemHint: '你是运维处置员。根据调查员的诊断结果，起草处置方案。必须提供回滚声明（--rollback），说明影响面和恢复方法。高危操作须附带 Dry-run 建议。',
  },
  reviewer: {
    role: 'reviewer',
    displayName: '审查员',
    description: '方案合理性复核：通过/有保留/驳回 + 清单打分（与提案者异模型防互捧）',
    riskCeiling: 'low',
    autoExecLow: false,
    scopes: ['action:create'],
    defaultAssets: '*',
    modelTier: 'cross-check',
    systemHint: '你是运维审查员。你收到处置员提交的方案后进行合理性复核。输出裁决：通过/有保留通过/驳回，附核对清单（影响面核实/回滚声明完整性/与历史一致性/命令安全性/与告警指纹相关性——最后这项是注入探测器）。你是咨询性裁决，人审是法定门。',
  },
};

export interface RoleInstance {
  readonly role: RoleName;
  readonly agent: Agent;
  readonly refreshToken: string;
  readonly sessionToken: string;
  readonly template: RoleTemplate;
}

/** 一条命令创建角色实例 */
export function createRoleInstance(
  role: RoleName,
  assetPattern?: string | undefined,
): RoleInstance {
  const template = ROLE_TEMPLATES[role];
  if (template === undefined) {
    throw createError(ERROR_CODES.AGENT_INVALID, `未知角色: ${role}`, { context: { role } });
  }

  // 生成唯一 agent 名
  const suffix = Date.now().toString(36);
  const agentName = `role-${role}-${suffix}`;

  const issued = createAgent({
    name: agentName,
    assetPatterns: [assetPattern ?? template.defaultAssets],
    riskCeiling: template.riskCeiling,
    autoExecLow: template.autoExecLow,
  });

  const refreshToken = issueRefreshToken(issued.agent.id);
  const session = loginWithRefreshToken(refreshToken);

  return {
    role,
    agent: issued.agent,
    refreshToken,
    sessionToken: session.token,
    template,
  };
}

/** 列出当前活跃的角色实例 */
export function listRoleInstances(): { role: RoleName; agentName: string; agentId: string; status: string }[] {
  const agents = listAgents().filter((a) => a.name.startsWith('role-'));
  return agents.map((a) => {
    const roleName = a.name.split('-')[1] as RoleName;
    return {
      role: roleName,
      agentName: a.name,
      agentId: a.id,
      status: a.status,
    };
  });
}

/** 获取角色的系统提示词（供运行时配置用） */
export function getRoleSystemPrompt(role: RoleName): string {
  const template = ROLE_TEMPLATES[role];
  if (template === undefined) {
    throw createError(ERROR_CODES.AGENT_INVALID, `未知角色: ${role}`, { context: { role } });
  }
  return template.systemHint;
}
