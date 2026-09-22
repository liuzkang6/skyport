/**
 * Agent 身份服务（M2）：key 签发（只显一次、库中仅存哈希）、三态管理、权限三件套校验。
 * 人的身份 = 本地 OS 用户（免 key，PRD §3 信任模型）；审批类操作只允许 human（见 actions 服务）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';
import { RISK_WEIGHT, type RiskLevel } from './risk';
import { z } from 'zod';

export const AGENT_STATUSES = ['active', 'paused', 'revoked'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const SCOPES = ['action:create', 'auto-exec-low'] as const;
export type Scope = (typeof SCOPES)[number];

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly keyHint: string;
  readonly status: AgentStatus;
  readonly scopes: readonly Scope[];
  readonly assetPatterns: readonly string[];
  readonly riskCeiling: RiskLevel;
  readonly expiresAt: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 签发结果：plaintextKey 只在创建返回值里出现一次，不落库、不再可查 */
export interface IssuedAgent {
  readonly agent: Agent;
  readonly plaintextKey: string;
}

export interface ActorRef {
  readonly type: 'human' | 'agent';
  readonly id: string;
  readonly name: string;
}

export interface CreateAgentInput {
  readonly name: string;
  readonly assetPatterns: readonly string[];
  readonly riskCeiling: RiskLevel;
  readonly autoExecLow: boolean;
  readonly expiresAt?: string | undefined;
}

interface AgentRow {
  id: string;
  name: string;
  key_hint: string;
  status: string;
  scopes: string;
  asset_patterns: string;
  risk_ceiling: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const NAME_MAX_LENGTH = 100;
const KEY_PREFIX = 'skp_';

const createAgentSchema = z.strictObject({
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  assetPatterns: z.array(z.string().trim().min(1)).min(1),
  riskCeiling: z.enum(['low', 'medium', 'high']),
  expiresAt: z.string().datetime().optional(),
});

/** 简版 glob：* 任意串，其余字面量；用于资产范围授权 */
export function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
  return regex.test(value);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function humanUserId(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown-human';
  }
}

export function createAgent(input: CreateAgentInput): IssuedAgent {
  // autoExecLow 是独立开关（决定 scopes），不进 strict schema，先剥离避免被当未知键拒绝
  const { autoExecLow, ...schemaInput } = input;
  const parsed = createAgentSchema.safeParse(schemaInput);
  if (!parsed.success) {
    throw createError(ERROR_CODES.AGENT_INVALID, 'agent 字段不合法', {
      context: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      },
    });
  }
  const plaintextKey = `${KEY_PREFIX}${randomBytes(16).toString('hex')}`;
  const keyHash = createHash('sha256').update(plaintextKey).digest('hex');
  const now = new Date().toISOString();
  const scopes: Scope[] = autoExecLow ? ['action:create', 'auto-exec-low'] : ['action:create'];
  const agent: Agent = {
    id: `agt_${randomBytes(4).toString('hex')}`,
    name: parsed.data.name,
    keyHint: `${plaintextKey.slice(0, 8)}****`,
    status: 'active',
    scopes,
    assetPatterns: parsed.data.assetPatterns,
    riskCeiling: parsed.data.riskCeiling,
    expiresAt: parsed.data.expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  try {
    getDb()
      .prepare(
        `INSERT INTO agents (id, name, key_hash, key_hint, status, scopes, asset_patterns, risk_ceiling, expires_at, created_at, updated_at)
         VALUES (@id, @name, @keyHash, @keyHint, 'active', @scopes, @assetPatterns, @riskCeiling, @expiresAt, @createdAt, @updatedAt)`,
      )
      .run({
        id: agent.id,
        name: agent.name,
        keyHash,
        keyHint: agent.keyHint,
        scopes: JSON.stringify(agent.scopes),
        assetPatterns: JSON.stringify(agent.assetPatterns),
        riskCeiling: agent.riskCeiling,
        expiresAt: agent.expiresAt ?? null,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      });
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw createError(ERROR_CODES.AGENT_DUPLICATE_NAME, `agent 名已存在: ${agent.name}`, {
        cause: error,
        context: { name: agent.name },
      });
    }
    throw createError(ERROR_CODES.DB_QUERY_FAILED, '数据库操作失败', { cause: error });
  }
  return { agent, plaintextKey };
}

export function getAgent(nameOrId: string): Agent {
  const row = getDb()
    .prepare('SELECT * FROM agents WHERE id = ? OR name = ?')
    .get(nameOrId, nameOrId) as AgentRow | undefined;
  if (row === undefined) {
    throw createError(ERROR_CODES.AGENT_NOT_FOUND, `agent 不存在: ${nameOrId}`, { context: { target: nameOrId } });
  }
  return rowToAgent(row);
}

export function listAgents(): Agent[] {
  const rows = getDb().prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function setAgentStatus(nameOrId: string, status: AgentStatus): Agent {
  const agent = getAgent(nameOrId);
  if (agent.status === 'revoked') {
    throw createError(ERROR_CODES.AGENT_INVALID, 'agent 已吊销，状态不可再变更（吊销是永久动作）', {
      context: { name: agent.name },
    });
  }
  getDb().prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), agent.id);
  return getAgent(agent.id);
}

/** key → 活跃 agent；无效 / paused / revoked / 过期 一律 PERMISSION_DENIED（不泄露具体原因给调用方） */
export function actorFromKey(apiKey: string): ActorRef {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const row = getDb().prepare('SELECT * FROM agents WHERE key_hash = ?').get(keyHash) as AgentRow | undefined;
  if (row === undefined) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, 'API key 无效', { context: {} });
  }
  const agent = rowToAgent(row);
  if (agent.status !== 'active') {
    throw createError(ERROR_CODES.PERMISSION_DENIED, `agent 当前状态不允许调用（${agent.status}）`, {
      context: { agent: agent.name, status: agent.status },
    });
  }
  if (agent.expiresAt !== undefined && Date.parse(agent.expiresAt) <= Date.now()) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, 'API key 已过期', { context: { agent: agent.name } });
  }
  return { type: 'agent', id: agent.id, name: agent.name };
}

/** 无 key = human（本地信任模型）；带 key = agent 身份 */
export function resolveActor(apiKey: string | undefined): ActorRef {
  if (apiKey === undefined) return { type: 'human', id: humanUserId(), name: humanUserId() };
  return actorFromKey(apiKey);
}

/** 审批 / 直通类操作只允许人执行：带 key 调用直接拒绝（治理红线） */
export function requireHumanActor(apiKey: string | undefined): ActorRef {
  if (apiKey !== undefined) {
    // 先验证 key 合法性（错误信息不区分无效/有效，统一"必须由人执行"）
    actorFromKey(apiKey);
    throw createError(ERROR_CODES.PERMISSION_DENIED, '此操作必须由人执行（审批与直通不允许 agent key）', {
      context: {},
    });
  }
  return { type: 'human', id: humanUserId(), name: humanUserId() };
}

/** 行动创建时的权限三件套校验（风险上限 / 资产范围 / 动作范围） */
export function assertAgentMayCreateAction(
  agent: Agent,
  targetName: string,
  risk: RiskLevel,
  autoExecRequested: boolean,
): void {
  if (!agent.scopes.includes('action:create')) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, 'agent 无 action:create 权限', {
      context: { agent: agent.name },
    });
  }
  if (RISK_WEIGHT[risk] > RISK_WEIGHT[agent.riskCeiling]) {
    throw createError(
      ERROR_CODES.PERMISSION_DENIED,
      `行动风险（${risk}）超出 agent 风险上限（${agent.riskCeiling}）`,
      { context: { agent: agent.name, risk, ceiling: agent.riskCeiling } },
    );
  }
  if (!agent.assetPatterns.some((pattern) => globMatch(pattern, targetName))) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, `目标（${targetName}）不在 agent 资产授权范围`, {
      context: { agent: agent.name, target: targetName, patterns: agent.assetPatterns },
    });
  }
  if (autoExecRequested && !agent.scopes.includes('auto-exec-low')) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, 'agent 无 auto-exec-low 权限，低危行动仍需人工审批', {
      context: { agent: agent.name },
    });
  }
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    keyHint: row.key_hint,
    status: row.status as AgentStatus,
    scopes: JSON.parse(row.scopes) as Scope[],
    assetPatterns: JSON.parse(row.asset_patterns) as string[],
    riskCeiling: row.risk_ceiling as RiskLevel,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
