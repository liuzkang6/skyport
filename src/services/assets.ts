/**
 * 资产台账服务（M1，spec/asset-inventory/spec.md）：登记 / 导入 / 查询 / 连通性检查 / 删除。
 * 只表达意图，不直接碰外部世界：DB 经 db 适配器、探测经 net 适配器、导入文件经 fs 适配器。
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../adapters/db';
import { readJsonFileSync } from '../adapters/fs';
import { tcpConnectCheck } from '../adapters/net';
import { getConfig } from '../config/config';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { z } from 'zod';

export const ASSET_TYPES = ['host', 'cluster', 'cloud-account'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const CONNECT_MODES = ['local', 'ssh', 'agent'] as const;
export type ConnectMode = (typeof CONNECT_MODES)[number];

export type AssetStatus = 'unknown' | 'up' | 'down';

const NAME_MAX_LENGTH = 100;
const ADDR_MAX_LENGTH = 255;
const DEFAULT_SSH_PORT = 22;
const LABEL_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;

const assetInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  type: z.enum(ASSET_TYPES),
  addr: z.string().trim().min(1).max(ADDR_MAX_LENGTH).optional(),
  connectMode: z.enum(CONNECT_MODES).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export interface AddAssetInput {
  readonly name: string;
  readonly type: AssetType;
  readonly addr?: string | undefined;
  readonly connectMode?: ConnectMode | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

interface PreparedAsset {
  readonly name: string;
  readonly type: AssetType;
  readonly addr: string | undefined;
  readonly connectMode: ConnectMode | undefined;
  readonly labels: Record<string, string>;
}

export interface Asset {
  readonly id: string;
  readonly name: string;
  readonly type: AssetType;
  readonly addr: string | undefined;
  readonly connectMode: ConnectMode | undefined;
  readonly labels: Readonly<Record<string, string>>;
  readonly status: AssetStatus;
  readonly lastCheckAt: string | undefined;
  readonly lastCheckLatencyMs: number | undefined;
  readonly lastCheckError: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AssetCheck {
  readonly ok: boolean;
  readonly latencyMs: number | undefined;
  readonly error: string | undefined;
  readonly checkedAt: string;
}

export interface CheckResult {
  readonly asset: Asset;
  readonly ok: boolean;
  readonly latencyMs: number | undefined;
  readonly error: string | undefined;
}

export interface ImportSummary {
  readonly added: number;
  readonly names: readonly string[];
}

interface AssetRow {
  id: string;
  name: string;
  type: string;
  addr: string | null;
  connect_mode: string | null;
  labels: string;
  status: string;
  last_check_at: string | null;
  last_check_latency_ms: number | null;
  last_check_error: string | null;
  created_at: string;
  updated_at: string;
}

interface CheckRow {
  ok: number;
  latency_ms: number | null;
  error: string | null;
  checked_at: string;
}

export function addAsset(input: AddAssetInput): Asset {
  return insertAsset(prepareAsset(input));
}

export function getAsset(nameOrId: string): Asset {
  const row = getDb()
    .prepare('SELECT * FROM assets WHERE id = ? OR name = ?')
    .get(nameOrId, nameOrId) as AssetRow | undefined;
  if (row === undefined) {
    throw createError(ERROR_CODES.ASSET_NOT_FOUND, `资产不存在: ${nameOrId}`, {
      context: { target: nameOrId },
    });
  }
  return rowToAsset(row);
}

export interface ListFilter {
  readonly type?: AssetType | undefined;
  readonly labelKey?: string | undefined;
  readonly labelValue?: string | undefined;
}

export function listAssets(filter: ListFilter = {}): Asset[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (filter.type !== undefined) {
    conditions.push('type = @type');
    params.type = filter.type;
  }
  if (filter.labelKey !== undefined && filter.labelValue !== undefined) {
    // 标签键已通过正则白名单校验，json path 拼接安全
    conditions.push("json_extract(labels, '$.' || @labelKey) = @labelValue");
    params.labelKey = filter.labelKey;
    params.labelValue = filter.labelValue;
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(
      `SELECT * FROM assets${where} ORDER BY CASE type WHEN 'host' THEN 1 WHEN 'cluster' THEN 2 ELSE 3 END, name`,
    )
    .all(params) as AssetRow[];
  return rows.map(rowToAsset);
}

export function removeAsset(nameOrId: string): void {
  const asset = getAsset(nameOrId);
  getDb().prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
}

export function getCheckHistory(nameOrId: string, limit = 5): AssetCheck[] {
  const asset = getAsset(nameOrId);
  const rows = getDb()
    .prepare(
      'SELECT ok, latency_ms, error, checked_at FROM asset_checks WHERE asset_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(asset.id, limit) as CheckRow[];
  return rows.map((row) => ({
    ok: row.ok === 1,
    latencyMs: row.latency_ms ?? undefined,
    error: row.error ?? undefined,
    checkedAt: row.checked_at,
  }));
}

export async function checkAsset(nameOrId: string): Promise<CheckResult> {
  const asset = getAsset(nameOrId);
  if (asset.type === 'cloud-account') {
    throw createError(ERROR_CODES.ASSET_INVALID, `云账户资产暂不支持连通性检查: ${asset.name}`, {
      context: { name: asset.name, type: asset.type },
    });
  }
  if (asset.addr === undefined) {
    throw createError(ERROR_CODES.ASSET_INVALID, `资产未登记地址，无法检查: ${asset.name}`, {
      context: { name: asset.name },
    });
  }
  const { host, port } = parseAddr(asset.addr, asset.connectMode);
  // user@ 前缀只影响 SSH 登录用户，连通性检查只探测 host
  const probe = await tcpConnectCheck(host, port, getConfig().checkTimeoutMs);
  const checkedAt = new Date().toISOString();
  const status: AssetStatus = probe.ok ? 'up' : 'down';
  const write = getDb().transaction(() => {
    getDb()
      .prepare('INSERT INTO asset_checks (asset_id, ok, latency_ms, error, checked_at) VALUES (?, ?, ?, ?, ?)')
      .run(asset.id, probe.ok ? 1 : 0, probe.latencyMs, probe.error ?? null, checkedAt);
    getDb()
      .prepare(
        'UPDATE assets SET status = ?, last_check_at = ?, last_check_latency_ms = ?, last_check_error = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, checkedAt, probe.latencyMs, probe.error ?? null, checkedAt, asset.id);
  });
  try {
    write();
  } catch (error) {
    throw dbQueryError(error);
  }
  return { asset: getAsset(asset.id), ok: probe.ok, latencyMs: probe.latencyMs, error: probe.error };
}

export function importAssets(filePath: string): ImportSummary {
  const raw = readJsonFileSync(filePath);
  if (!Array.isArray(raw)) {
    throw createError(ERROR_CODES.ASSET_INVALID, `导入文件必须是 JSON 数组: ${filePath}`, {
      context: { path: filePath },
    });
  }
  const preparedList = raw.map((entry, index) => {
    try {
      return prepareAsset(entry);
    } catch (error) {
      if (isSkyportError(error)) {
        throw createError(error.type, `第 ${index + 1} 条资产不合法：${error.message}`, {
          context: { ...error.context, index: index + 1, path: filePath },
        });
      }
      throw error;
    }
  });
  // 文件内重名先拦（同批插入让 UNIQUE 约束兜底不了语义清晰的报错）
  const seen = new Set<string>();
  for (const prepared of preparedList) {
    if (seen.has(prepared.name)) {
      throw createError(ERROR_CODES.ASSET_DUPLICATE_NAME, `导入文件内资产名重复: ${prepared.name}`, {
        context: { name: prepared.name, source: 'file', path: filePath },
      });
    }
    seen.add(prepared.name);
  }
  const importAll = getDb().transaction(() => {
    for (const prepared of preparedList) insertAsset(prepared);
  });
  try {
    importAll();
  } catch (error) {
    // insertAsset 已把 UNIQUE 违约转成 ASSET_DUPLICATE_NAME；这里补上下文（事务已整体回滚）
    if (isSkyportError(error) && error.type === ERROR_CODES.ASSET_DUPLICATE_NAME) {
      throw createError(ERROR_CODES.ASSET_DUPLICATE_NAME, '资产名已存在（导入中止，本批已全部回滚）', {
        cause: error,
        context: { ...error.context, source: 'db', path: filePath },
      });
    }
    throw dbQueryError(error);
  }
  const names = preparedList.map((prepared) => prepared.name);
  return { added: names.length, names };
}

/** CLI --label key=value（可重复）解析；格式与键字符集在此统一校验 */
export function parseLabelPairs(pairs: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    const key = eq > 0 ? pair.slice(0, eq) : '';
    const value = eq > 0 ? pair.slice(eq + 1) : '';
    if (eq <= 0 || !LABEL_KEY_PATTERN.test(key) || value.length === 0) {
      throw createError(ERROR_CODES.ASSET_INVALID, `标签格式应为 key=value（键含字母数字_.-，值非空）: ${pair}`);
    }
    labels[key] = value;
  }
  return labels;
}

function prepareAsset(raw: unknown): PreparedAsset {
  const parsed = assetInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw createError(ERROR_CODES.ASSET_INVALID, '资产字段不合法', {
      context: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      },
    });
  }
  const value = parsed.data;
  if (value.type === 'host' && value.addr === undefined) {
    throw createError(ERROR_CODES.ASSET_INVALID, 'host 资产必须登记地址（--addr）', {
      context: { name: value.name },
    });
  }
  if (value.connectMode === 'agent') {
    throw createError(ERROR_CODES.ASSET_INVALID, 'agent 连接模式将在 v2 提供，当前可选 local / ssh', {
      context: { name: value.name },
    });
  }
  return {
    name: value.name,
    type: value.type,
    addr: value.addr,
    connectMode: value.connectMode ?? (value.type === 'host' ? 'ssh' : undefined),
    labels: value.labels ?? {},
  };
}

function insertAsset(prepared: PreparedAsset): Asset {
  const db = getDb();
  const now = new Date().toISOString();
  const asset: Asset = {
    id: `ast_${randomBytes(4).toString('hex')}`,
    name: prepared.name,
    type: prepared.type,
    addr: prepared.addr,
    connectMode: prepared.connectMode,
    labels: prepared.labels,
    status: 'unknown',
    lastCheckAt: undefined,
    lastCheckLatencyMs: undefined,
    lastCheckError: undefined,
    createdAt: now,
    updatedAt: now,
  };
  try {
    db.prepare(
      `INSERT INTO assets (id, name, type, addr, connect_mode, labels, status, created_at, updated_at)
       VALUES (@id, @name, @type, @addr, @connectMode, @labels, 'unknown', @createdAt, @updatedAt)`,
    ).run({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      addr: asset.addr ?? null,
      connectMode: asset.connectMode ?? null,
      labels: JSON.stringify(asset.labels),
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw createError(ERROR_CODES.ASSET_DUPLICATE_NAME, `资产名已存在: ${prepared.name}`, {
        cause: error,
        context: { name: prepared.name },
      });
    }
    throw dbQueryError(error);
  }
  return asset;
}

/** addr 支持 [user@]host[:port] / [user@][IPv6]:port；ssh 模式可省端口（默认 22），其余必须带端口。
 *  user 只对 SSH 执行有意义：连通性检查永远只探测 host 部分。 */
export function parseAddr(
  addr: string,
  connectMode: ConnectMode | undefined,
): { user: string | undefined; host: string; port: number } {
  let rest = addr.trim();
  let user: string | undefined;
  const at = rest.indexOf('@');
  if (at > 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let host = rest;
  let port: number | undefined;
  const colon = host.lastIndexOf(':');
  if (colon > 0) {
    const tail = host.slice(colon + 1);
    const parsedPort = Number(tail);
    if (tail.length > 0 && Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
      port = parsedPort;
      host = host.slice(0, colon);
    }
  }
  host = host.replace(/^\[/, '').replace(/\]$/, '');
  if (host.length === 0 || (user !== undefined && user.length === 0)) {
    throw createError(ERROR_CODES.ASSET_INVALID, `地址不合法: ${addr}`, { context: { addr } });
  }
  if (port === undefined) {
    if (connectMode === 'ssh') return { user, host, port: DEFAULT_SSH_PORT };
    throw createError(ERROR_CODES.ASSET_INVALID, `地址需含端口（host:port），ssh 模式可省略: ${addr}`, {
      context: { addr },
    });
  }
  return { user, host, port };
}

function rowToAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    name: row.name,
    type: row.type as AssetType,
    addr: row.addr ?? undefined,
    connectMode: (row.connect_mode ?? undefined) as ConnectMode | undefined,
    labels: JSON.parse(row.labels) as Record<string, string>,
    status: row.status as AssetStatus,
    lastCheckAt: row.last_check_at ?? undefined,
    lastCheckLatencyMs: row.last_check_latency_ms ?? undefined,
    lastCheckError: row.last_check_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function dbQueryError(error: unknown): Error {
  return createError(ERROR_CODES.DB_QUERY_FAILED, '数据库操作失败', { cause: error });
}
