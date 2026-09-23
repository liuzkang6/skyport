/**
 * 插件体系骨架（PRD §2）：企业技术栈接入 = 插件 = 工具 + 技能包。
 * 生命周期：install → enable/disable → uninstall；启停受治理进审计。
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../adapters/db';
import { createError, ERROR_CODES } from '../errors/errors';

export interface Plugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | undefined;
  readonly capabilities: readonly string[];
  readonly enabled: boolean;
  readonly source: string;
  readonly installedAt: string;
}

export function installPlugin(input: {
  name: string;
  version: string;
  description?: string | undefined;
  capabilities?: string[] | undefined;
  source?: string | undefined;
}): Plugin {
  const id = `plg_${randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  try {
    getDb()
      .prepare('INSERT INTO plugins (id, name, version, description, capabilities, enabled, source, installed_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(id, input.name, input.version, input.description ?? null, JSON.stringify(input.capabilities ?? []), input.source ?? 'local', now);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw createError(ERROR_CODES.ASSET_DUPLICATE_NAME, `插件已安装: ${input.name}`, { context: { name: input.name } });
    }
    throw error;
  }
  return getPlugin(input.name);
}

export function getPlugin(nameOrId: string): Plugin {
  const row = getDb().prepare('SELECT * FROM plugins WHERE id = ? OR name = ?').get(nameOrId, nameOrId) as PluginRow | undefined;
  if (row === undefined) throw createError(ERROR_CODES.ASSET_NOT_FOUND, `插件不存在: ${nameOrId}`, { context: { target: nameOrId } });
  return rowToPlugin(row);
}

export function listPlugins(): Plugin[] {
  return (getDb().prepare('SELECT * FROM plugins ORDER BY name').all() as PluginRow[]).map(rowToPlugin);
}

export function setPluginEnabled(nameOrId: string, enabled: boolean): Plugin {
  const plugin = getPlugin(nameOrId);
  getDb().prepare('UPDATE plugins SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, plugin.id);
  return getPlugin(plugin.id);
}

export function uninstallPlugin(nameOrId: string): void {
  const plugin = getPlugin(nameOrId);
  getDb().prepare('DELETE FROM plugins WHERE id = ?').run(plugin.id);
}

interface PluginRow {
  id: string; name: string; version: string; description: string | null;
  capabilities: string; enabled: number; source: string; installed_at: string;
}

function rowToPlugin(row: PluginRow): Plugin {
  return {
    id: row.id, name: row.name, version: row.version, description: row.description ?? undefined,
    capabilities: JSON.parse(row.capabilities), enabled: row.enabled === 1, source: row.source, installedAt: row.installed_at,
  };
}
