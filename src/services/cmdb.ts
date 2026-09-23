/**
 * CMDB-lite v2：服务目录 + 依赖拓扑边 + 资产-服务关联（PRD 知识层）。
 * 拓扑是态势包"影响面预演"的数据源：告警资产 → 关联服务 → 上游/下游传播。
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';
import { z } from 'zod';
import { getAsset } from './assets';

export interface Service {
  readonly id: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly owner: string | undefined;
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServiceDependency {
  readonly serviceId: string;
  readonly dependsOnServiceId: string;
}

const serviceSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  owner: z.string().max(100).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export function createService(input: {
  name: string;
  description?: string | undefined;
  owner?: string | undefined;
  labels?: Record<string, string> | undefined;
}): Service {
  const parsed = serviceSchema.safeParse(input);
  if (!parsed.success) {
    throw createError(ERROR_CODES.ASSET_INVALID, '服务字段不合法', { context: { issues: parsed.error.issues.map((i) => i.message) } });
  }
  const now = new Date().toISOString();
  const service: Service = {
    id: `svc_${randomBytes(4).toString('hex')}`,
    name: parsed.data.name,
    description: parsed.data.description,
    owner: parsed.data.owner,
    labels: parsed.data.labels ?? {},
    createdAt: now,
    updatedAt: now,
  };
  try {
    getDb()
      .prepare('INSERT INTO services (id, name, description, owner, labels, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(service.id, service.name, service.description ?? null, service.owner ?? null, JSON.stringify(service.labels), now, now);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw createError(ERROR_CODES.ASSET_DUPLICATE_NAME, `服务名已存在: ${service.name}`, { cause: error, context: { name: service.name } });
    }
    throw createError(ERROR_CODES.DB_QUERY_FAILED, '数据库操作失败', { cause: error });
  }
  return service;
}

export function getService(nameOrId: string): Service {
  const row = getDb().prepare('SELECT * FROM services WHERE id = ? OR name = ?').get(nameOrId, nameOrId) as ServiceRow | undefined;
  if (row === undefined) throw createError(ERROR_CODES.ASSET_NOT_FOUND, `服务不存在: ${nameOrId}`, { context: { target: nameOrId } });
  return rowToService(row);
}

export function listServices(): Service[] {
  return (getDb().prepare('SELECT * FROM services ORDER BY name').all() as ServiceRow[]).map(rowToService);
}

/**
 * 读侧范围（红队 V5）：agent 令牌只看到挂有范围内资产的服务；human 全量。
 * scopePatterns === undefined 表示 human（不过滤）；agent 无模式（理论不可能，创建时 min(1)）返回空。
 */
export function listServicesScoped(scopePatterns: readonly string[] | undefined): Service[] {
  if (scopePatterns === undefined) return listServices();
  if (scopePatterns.length === 0) return [];
  const globClauses = scopePatterns
    .map(() => 'a.name GLOB ?')
    .join(' OR ');
  const globArgs = scopePatterns.map((pattern) => pattern.replace(/[?[\]]/g, (c) => `[${c}]`));
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT s.* FROM services s
       JOIN asset_services x ON x.service_id = s.id
       JOIN assets a ON a.id = x.asset_id
       WHERE ${globClauses}
       ORDER BY s.name`,
    )
    .all(...globArgs) as ServiceRow[];
  return rows.map(rowToService);
}

export function removeService(nameOrId: string): void {
  const service = getService(nameOrId);
  getDb().prepare('DELETE FROM services WHERE id = ?').run(service.id);
}

export function addDependency(serviceName: string, dependsOn: string): void {
  const from = getService(serviceName);
  const to = getService(dependsOn);
  if (from.id === to.id) throw createError(ERROR_CODES.ASSET_INVALID, '服务不能依赖自身');
  try {
    getDb().prepare('INSERT INTO service_dependencies (service_id, depends_on_service_id, created_at) VALUES (?, ?, ?)').run(from.id, to.id, new Date().toISOString());
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw createError(ERROR_CODES.ASSET_DUPLICATE_NAME, `依赖已存在: ${from.name} → ${to.name}`, { cause: error });
    }
    throw error;
  }
}

export function removeDependency(serviceName: string, dependsOn: string): void {
  const from = getService(serviceName);
  const to = getService(dependsOn);
  getDb().prepare('DELETE FROM service_dependencies WHERE service_id = ? AND depends_on_service_id = ?').run(from.id, to.id);
}

export function listDependencies(): ServiceDependency[] {
  const rows = getDb().prepare('SELECT service_id, depends_on_service_id FROM service_dependencies').all() as { service_id: string; depends_on_service_id: string }[];
  return rows.map((r) => ({ serviceId: r.service_id, dependsOnServiceId: r.depends_on_service_id }));
}

export function linkAssetToService(assetNameOrId: string, serviceNameOrId: string): void {
  // 延迟导入避免循环依赖
  const asset = getAsset(assetNameOrId);
  const service = getService(serviceNameOrId);
  getDb().prepare('INSERT OR IGNORE INTO asset_services (asset_id, service_id) VALUES (?, ?)').run(asset.id, service.id);
}

export function unlinkAssetFromService(assetNameOrId: string, serviceNameOrId: string): void {
  const asset = getAsset(assetNameOrId);
  const service = getService(serviceNameOrId);
  getDb().prepare('DELETE FROM asset_services WHERE asset_id = ? AND service_id = ?').run(asset.id, service.id);
}

/** 查询资产关联的服务列表 */
export function getAssetServices(assetId: string): Service[] {
  return (getDb()
    .prepare('SELECT s.* FROM services s JOIN asset_services asv ON asv.service_id = s.id WHERE asv.asset_id = ?')
    .all(assetId) as ServiceRow[]).map(rowToService);
}

/** 拓扑影响面：资产 → 关联服务 → 上下游传播（态势包"影响面预演"的数据源） */
export function getBlastRadius(assetNameOrId: string): { services: Service[]; upstream: Service[]; downstream: Service[] } {
  const asset = getAsset(assetNameOrId);
  const services = getAssetServices(asset.id);
  const upstream: Service[] = [];
  const downstream: Service[] = [];
  for (const svc of services) {
    // 上游：本服务依赖的服务
    const upRows = getDb()
      .prepare('SELECT s.* FROM services s JOIN service_dependencies d ON d.depends_on_service_id = s.id WHERE d.service_id = ?')
      .all(svc.id) as ServiceRow[];
    upstream.push(...upRows.map(rowToService));
    // 下游：依赖本服务的服务
    const downRows = getDb()
      .prepare('SELECT s.* FROM services s JOIN service_dependencies d ON d.service_id = s.id WHERE d.depends_on_service_id = ?')
      .all(svc.id) as ServiceRow[];
    downstream.push(...downRows.map(rowToService));
  }
  const dedupe = (arr: Service[]) => {
    const seen = new Set<string>();
    return arr.filter((s) => !seen.has(s.id) && seen.add(s.id) && s.id !== undefined);
  };
  return { services, upstream: dedupe(upstream), downstream: dedupe(downstream) };
}

interface ServiceRow {
  id: string; name: string; description: string | null; owner: string | null; labels: string; created_at: string; updated_at: string;
}

function rowToService(row: ServiceRow): Service {
  return {
    id: row.id, name: row.name, description: row.description ?? undefined, owner: row.owner ?? undefined,
    labels: JSON.parse(row.labels), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
