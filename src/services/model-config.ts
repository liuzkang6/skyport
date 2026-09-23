/**
 * 模型配置中心（spec/llm-seat）：LLM 座位的模型登记与选型。
 * 安全决定：API key 只存保险箱（AES-256-GCM，引用名 model:<name>），
 * 本表与任何 API 响应都不回传 key；tier（cheap/strong）供四角色
 * 按档选模型——巡查员用 cheap，调查/处置/审查用 strong。
 */
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';
import { getSecret, removeSecret, setSecret } from './vault';

export type ModelTier = 'cheap' | 'strong';

export interface ModelConfigInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly tier: ModelTier;
  readonly enabled: boolean;
}

/** API 视图：永不包含 key */
export interface ModelConfigView {
  readonly id: number;
  readonly name: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly enabled: boolean;
  readonly lastUsedAt: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 内部视图：含解出的 key（仅 llm.ts 消费，不得外泄到 API 响应/日志） */
export interface ResolvedModel extends ModelConfigView {
  readonly apiKey: string;
}

interface ModelRow {
  id: number;
  name: string;
  base_url: string;
  model_id: string;
  api_key_secret: string;
  tier: string;
  enabled: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function apiKeyRef(name: string): string {
  return `model:${name}`;
}

export function upsertModelConfig(input: ModelConfigInput): ModelConfigView {
  const name = input.name.trim();
  if (name === '') throw createError(ERROR_CODES.CONFIG_INVALID, '模型名不能为空', { context: {} });
  if (!/^https?:\/\//.test(input.baseUrl)) {
    throw createError(ERROR_CODES.CONFIG_INVALID, 'baseUrl 必须是 http(s) 地址', { context: { baseUrl: input.baseUrl } });
  }
  if (input.modelId.trim() === '') throw createError(ERROR_CODES.CONFIG_INVALID, 'modelId 不能为空', { context: {} });
  if (input.apiKey.trim() === '') throw createError(ERROR_CODES.CONFIG_INVALID, 'apiKey 不能为空', { context: {} });

  // key 先入保险箱（存在即覆盖，版本自增）
  setSecret(apiKeyRef(name), input.apiKey.trim());
  const now = new Date().toISOString();
  const existing = getDb().prepare('SELECT id FROM model_configs WHERE name = ?').get(name) as { id: number } | undefined;
  if (existing === undefined) {
    getDb().prepare(
      `INSERT INTO model_configs (name, base_url, model_id, api_key_secret, tier, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, input.baseUrl.replace(/\/$/, ''), input.modelId.trim(), apiKeyRef(name), input.tier, input.enabled ? 1 : 0, now, now);
  } else {
    getDb().prepare(
      `UPDATE model_configs SET base_url = ?, model_id = ?, tier = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    ).run(input.baseUrl.replace(/\/$/, ''), input.modelId.trim(), input.tier, input.enabled ? 1 : 0, now, existing.id);
  }
  return getModelByName(name);
}

export function deleteModelConfig(name: string): void {
  const row = getDb().prepare('SELECT id FROM model_configs WHERE name = ?').get(name) as { id: number } | undefined;
  if (row === undefined) throw createError(ERROR_CODES.CONFIG_INVALID, `模型配置不存在: ${name}`, { context: { name } });
  getDb().prepare('DELETE FROM model_configs WHERE id = ?').run(row.id);
  try { removeSecret(apiKeyRef(name)); } catch { /* 保险箱无记录则忽略 */ }
}

export function listModelConfigs(): ModelConfigView[] {
  return (getDb().prepare('SELECT * FROM model_configs ORDER BY id').all() as ModelRow[]).map(rowToView);
}

export function getModelByName(name: string): ModelConfigView {
  const row = getDb().prepare('SELECT * FROM model_configs WHERE name = ?').get(name) as ModelRow | undefined;
  if (row === undefined) throw createError(ERROR_CODES.CONFIG_INVALID, `模型配置不存在: ${name}`, { context: { name } });
  return rowToView(row);
}

/** 按档位选模型：优先该档启用模型，其次任意启用模型 */
export function resolveModelForTier(tier: ModelTier): ResolvedModel {
  const rows = getDb().prepare('SELECT * FROM model_configs WHERE enabled = 1 ORDER BY id').all() as ModelRow[];
  if (rows.length === 0) {
    throw createError(ERROR_CODES.CONFIG_INVALID, '未配置任何模型（设置 → 模型配置，或 POST /api/v1/models）', { context: {} });
  }
  const row = rows.find((r) => r.tier === tier) ?? rows[0]!;
  const secret = getSecret(apiKeyRef(row.name));
  return { ...rowToView(row), apiKey: secret.value };
}

/** 记录最近使用（llm 调用后回写，供配置页展示活性） */
export function touchModelUsed(name: string): void {
  getDb().prepare('UPDATE model_configs SET last_used_at = ? WHERE name = ?').run(new Date().toISOString(), name);
}

function rowToView(row: ModelRow): ModelConfigView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    modelId: row.model_id,
    tier: (row.tier === 'strong' ? 'strong' : 'cheap'),
    enabled: row.enabled === 1,
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
