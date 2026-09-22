import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { addAsset } from './assets';
import {
  addDependency,
  createService,
  getBlastRadius,
  getService,
  linkAssetToService,
  listDependencies,
  listServices,
  removeDependency,
  removeService,
} from './cmdb';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-cmdb-'));
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

describe('CMDB-lite v2：服务目录与拓扑', () => {
  it('正常路径：创建/查询/列表/删除服务', () => {
    createService({ name: 'svc-api', description: 'API 网关', owner: 'liu', labels: { env: 'prod' } });
    const svc = getService('svc-api');
    expect(svc.id).toMatch(/^svc_[0-9a-f]{8}$/);
    expect(svc.labels).toEqual({ env: 'prod' });
    expect(listServices()).toHaveLength(1);
    removeService('svc-api');
    expect(cap(() => getService('svc-api'))).toBe('SKYPORT_ASSET_NOT_FOUND');
  });

  it('失败路径-重名：服务名已存在 → ASSET_DUPLICATE_NAME', () => {
    createService({ name: 'dup' });
    expect(cap(() => createService({ name: 'dup' }))).toBe('SKYPORT_ASSET_DUPLICATE_NAME');
  });

  it('依赖拓扑：添加/列表/删除依赖边', () => {
    createService({ name: 'svc-api' });
    createService({ name: 'svc-db' });
    addDependency('svc-api', 'svc-db');
    expect(listDependencies()).toHaveLength(1);
    removeDependency('svc-api', 'svc-db');
    expect(listDependencies()).toHaveLength(0);
  });

  it('失败路径-自依赖：服务不能依赖自身', () => {
    createService({ name: 'self' });
    expect(cap(() => addDependency('self', 'self'))).toBe('SKYPORT_ASSET_INVALID');
  });

  it('影响面预演：资产→关联服务→上下游传播', () => {
    addAsset({ name: 'db-01', type: 'host', addr: '10.0.2.10' });
    addAsset({ name: 'web-01', type: 'host', addr: '10.0.1.11' });
    createService({ name: 'svc-api' });
    createService({ name: 'svc-db' });
    createService({ name: 'svc-monitor' });
    linkAssetToService('db-01', 'svc-db');
    linkAssetToService('web-01', 'svc-api');
    // svc-api 依赖 svc-db；svc-monitor 依赖 svc-api
    addDependency('svc-api', 'svc-db');
    addDependency('svc-monitor', 'svc-api');

    // db-01 的爆炸半径：svc-db 的下游是 svc-api
    const blast = getBlastRadius('db-01');
    expect(blast.services.map((s) => s.name)).toContain('svc-db');
    expect(blast.downstream.map((s) => s.name)).toContain('svc-api');
  });
});
