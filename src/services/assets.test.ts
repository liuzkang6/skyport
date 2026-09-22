import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import {
  addAsset,
  checkAsset,
  getAsset,
  getCheckHistory,
  importAssets,
  listAssets,
  parseAddr,
  parseLabelPairs,
  removeAsset,
} from './assets';

let tempDir: string;
let dbPath: string;
const servers: Server[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-assets-'));
  dbPath = join(tempDir, 'skyport.db');
  process.env.SKYPORT_DB_PATH = dbPath;
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  await rm(tempDir, { recursive: true, force: true });
});

async function listenLocal(): Promise<number> {
  const server = createServer(() => undefined);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

function captureAssetError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isSkyportError(error)) return error.type;
    throw error;
  }
  throw new Error('期望抛出资产错误，但它正常返回了');
}

async function captureAssetErrorAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isSkyportError(error)) return error.type;
    throw error;
  }
  throw new Error('期望抛出资产错误，但它正常返回了');
}

describe('assets 资产台账服务', () => {
  it('正常路径：登记主机（默认 ssh 模式、unknown 状态），按 name 与 id 均可取回', () => {
    const created = addAsset({
      name: 'web-01',
      type: 'host',
      addr: '10.0.1.11',
      labels: { env: 'prod', tier: 'web' },
    });
    expect(created.id).toMatch(/^ast_[0-9a-f]{8}$/);
    expect(created.connectMode).toBe('ssh');
    expect(created.status).toBe('unknown');
    expect(getAsset('web-01').id).toBe(created.id);
    expect(getAsset(created.id).name).toBe('web-01');
    expect(getAsset('web-01').labels).toEqual({ env: 'prod', tier: 'web' });
  });

  it('失败路径-重复：同名资产 → ASSET_DUPLICATE_NAME', () => {
    addAsset({ name: 'dup', type: 'host', addr: '10.0.0.1' });
    const type = captureAssetError(() => addAsset({ name: 'dup', type: 'host', addr: '10.0.0.2' }));
    expect(type).toBe('SKYPORT_ASSET_DUPLICATE_NAME');
  });

  it('失败路径-空输入/缺字段：host 无地址、空 name、agent 模式 → ASSET_INVALID', () => {
    expect(captureAssetError(() => addAsset({ name: 'no-addr', type: 'host' }))).toBe('SKYPORT_ASSET_INVALID');
    expect(captureAssetError(() => addAsset({ name: '   ', type: 'host', addr: '10.0.0.1' }))).toBe(
      'SKYPORT_ASSET_INVALID',
    );
    expect(
      captureAssetError(() => addAsset({ name: 'agent-mode', type: 'host', addr: '10.0.0.1', connectMode: 'agent' })),
    ).toBe('SKYPORT_ASSET_INVALID');
  });

  it('失败路径-超长：name 超 100 字符 → ASSET_INVALID', () => {
    const type = captureAssetError(() => addAsset({ name: 'x'.repeat(101), type: 'host', addr: '10.0.0.1' }));
    expect(type).toBe('SKYPORT_ASSET_INVALID');
  });

  it('失败路径-标签格式：无等号 / 非法键字符 → ASSET_INVALID；合法标签解析正确', () => {
    expect(captureAssetError(() => parseLabelPairs(['bad-format']))).toBe('SKYPORT_ASSET_INVALID');
    expect(captureAssetError(() => parseLabelPairs(['bad key=1']))).toBe('SKYPORT_ASSET_INVALID');
    expect(parseLabelPairs(['env=prod', 'tier=web'])).toEqual({ env: 'prod', tier: 'web' });
  });

  it('正常路径：list 按类型与标签过滤（json_extract）', () => {
    addAsset({ name: 'web-01', type: 'host', addr: '10.0.1.11', labels: { env: 'prod' } });
    addAsset({ name: 'web-02', type: 'host', addr: '10.0.1.12', labels: { env: 'prod' } });
    addAsset({ name: 'stg-01', type: 'host', addr: '10.0.2.11', labels: { env: 'stg' } });
    addAsset({ name: 'prod-k8s', type: 'cluster', addr: '10.1.0.1:6443' });
    expect(listAssets()).toHaveLength(4);
    expect(listAssets({ type: 'host' })).toHaveLength(3);
    expect(listAssets({ type: 'cluster' })).toHaveLength(1);
    expect(listAssets({ labelKey: 'env', labelValue: 'prod' })).toHaveLength(2);
  });

  it('正常路径：import 批量导入；失败路径-非数组与撞库均报错且回滚', async () => {
    const file = join(tempDir, 'fleet.json');
    await writeFile(file, JSON.stringify([{ name: 'a-1', type: 'host', addr: '10.0.0.1' }, { name: 'c-1', type: 'cluster' }]), 'utf8');
    const summary = importAssets(file);
    expect(summary.added).toBe(2);
    expect(getAsset('a-1').type).toBe('host');

    const notArray = join(tempDir, 'bad.json');
    await writeFile(notArray, JSON.stringify({ nope: true }), 'utf8');
    expect(captureAssetError(() => importAssets(notArray))).toBe('SKYPORT_ASSET_INVALID');

    const dupFile = join(tempDir, 'dup.json');
    await writeFile(dupFile, JSON.stringify([{ name: 'a-1', type: 'host', addr: '10.0.9.9' }]), 'utf8');
    expect(captureAssetError(() => importAssets(dupFile))).toBe('SKYPORT_ASSET_DUPLICATE_NAME');
    // 全有或全无：撞库批次不得留下任何数据
    expect(listAssets()).toHaveLength(2);
  });

  it('失败路径-导入文件不存在 → FS_NOT_FOUND', () => {
    const missing = join(tempDir, 'missing.json');
    expect(captureAssetError(() => importAssets(missing))).toBe('SKYPORT_FS_NOT_FOUND');
  });

  it('正常路径-检查通：本地监听端口 → up + 延迟 + 历史；按 name 检查后 show 可见', async () => {
    const port = await listenLocal();
    addAsset({ name: 'local-svc', type: 'host', addr: `127.0.0.1:${port}`, connectMode: 'local' });
    const result = await checkAsset('local-svc');
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.asset.status).toBe('up');
    expect(getCheckHistory('local-svc')).toHaveLength(1);
  });

  it('失败路径-检查断（探测失败是数据不是错误）：拒绝连接的端口 → down + 原因，退出语义正常', async () => {
    addAsset({ name: 'dead-svc', type: 'host', addr: '127.0.0.1:1', connectMode: 'local' });
    const result = await checkAsset('dead-svc');
    expect(result.ok).toBe(false);
    expect(result.asset.status).toBe('down');
    expect(result.asset.lastCheckError).toBeTruthy();
  });

  it('失败路径-检查前置校验：云账户类型 / 无地址资产 → ASSET_INVALID', async () => {
    addAsset({ name: 'cloud-1', type: 'cloud-account' });
    addAsset({ name: 'cluster-1', type: 'cluster' });
    expect(await captureAssetErrorAsync(() => checkAsset('cloud-1'))).toBe('SKYPORT_ASSET_INVALID');
    expect(await captureAssetErrorAsync(() => checkAsset('cluster-1'))).toBe('SKYPORT_ASSET_INVALID');
  });

  it('失败路径-地址缺端口且非 ssh 模式 → ASSET_INVALID；ssh 模式默认 22 可检查', async () => {
    addAsset({ name: 'no-port', type: 'host', addr: '127.0.0.1', connectMode: 'local' });
    expect(await captureAssetErrorAsync(() => checkAsset('no-port'))).toBe('SKYPORT_ASSET_INVALID');
  });

  it('地址支持 [user@]host[:port]：user 只影响 SSH 登录，检查只探测 host（parseAddr 契约）', async () => {
    expect(parseAddr('root@10.55.30.205', 'ssh')).toEqual({ user: 'root', host: '10.55.30.205', port: 22 });
    expect(parseAddr('liu@127.0.0.1:2222', 'local')).toEqual({ user: 'liu', host: '127.0.0.1', port: 2222 });
    expect(parseAddr('10.0.0.1', 'ssh')).toEqual({ user: undefined, host: '10.0.0.1', port: 22 });
    // user@ 前缀不影响检查连通性：仍按 host 探测
    const port = await listenLocal();
    addAsset({ name: 'user-host', type: 'host', addr: `ops@127.0.0.1:${port}`, connectMode: 'local' });
    const result = await checkAsset('user-host');
    expect(result.ok).toBe(true);
  });

  it('失败路径-目标不存在：get/check/remove → ASSET_NOT_FOUND', async () => {
    expect(captureAssetError(() => getAsset('ghost'))).toBe('SKYPORT_ASSET_NOT_FOUND');
    expect(await captureAssetErrorAsync(() => checkAsset('ghost'))).toBe('SKYPORT_ASSET_NOT_FOUND');
    expect(captureAssetError(() => removeAsset('ghost'))).toBe('SKYPORT_ASSET_NOT_FOUND');
  });

  it('正常路径：remove 删除资产并级联清理检查历史', async () => {
    const port = await listenLocal();
    addAsset({ name: 'gone', type: 'host', addr: `127.0.0.1:${port}`, connectMode: 'local' });
    const id = getAsset('gone').id;
    await checkAsset('gone');
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM asset_checks WHERE asset_id = ?').get(id)).toMatchObject({ c: 1 });
    removeAsset('gone');
    expect(captureAssetError(() => getAsset('gone'))).toBe('SKYPORT_ASSET_NOT_FOUND');
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM asset_checks WHERE asset_id = ?').get(id) as { c: number };
    expect(row.c).toBe(0);
  });
});
