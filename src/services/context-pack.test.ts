import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { addAsset, checkAsset } from './assets';
import { addDependency, createService, linkAssetToService } from './cmdb';
import { detectAndParse, ingestAlert } from './alert-bus';
import { buildContextPack, summarizeContextPack } from './context-pack';
import { humanUserId, type ActorRef } from './agents';
import { createAction } from './actions';

let tempDir: string;
const HUMAN: ActorRef = { type: 'human', id: humanUserId(), name: humanUserId() };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-pack-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('态势包 v1 / Context Pack', () => {
  it('正常路径：组装完整态势包（资产卡+检查+服务+拓扑）', async () => {
    addAsset({ name: 'pack-host', type: 'host', addr: '127.0.0.1:8080', connectMode: 'local', labels: { env: 'test' } });
    createService({ name: 'svc-pack' });
    linkAssetToService('pack-host', 'svc-pack');
    await checkAsset('pack-host');

    const pack = buildContextPack('pack-host');
    expect(pack.asset.name).toBe('pack-host');
    expect(pack.asset.labels).toEqual({ env: 'test' });
    expect(pack.checks.length).toBeGreaterThanOrEqual(1);
    expect(pack.services).toContain('svc-pack');
    expect(pack.assembledAt).toBeDefined();
  });

  it('关联告警：同资产的 open 告警出现在态势包中', () => {
    addAsset({ name: 'alerted', type: 'host', addr: '10.0.0.1' });
    const parsed = detectAndParse({ event: 'DiskFull', resource: 'alerted', severity: 'critical' });
    ingestAlert(parsed[0]!);

    const pack = buildContextPack('alerted');
    expect(pack.openAlerts.length).toBeGreaterThanOrEqual(1);
    expect(pack.openAlerts[0]!.event).toBe('DiskFull');
  });

  it('近期变更：该资产的最近行动包含在态势包中', async () => {
    addAsset({ name: 'acted', type: 'host', addr: '10.0.0.2' });
    await createAction({ command: 'echo hello', actor: HUMAN, target: 'acted' });

    const pack = buildContextPack('acted');
    expect(pack.recentActions.length).toBeGreaterThanOrEqual(1);
    expect(pack.recentActions[0]!.command).toBe('echo hello');
  });

  it('拓扑影响面：爆炸半径数据包含在态势包中', () => {
    addAsset({ name: 'topo-host', type: 'host', addr: '10.0.0.3' });
    createService({ name: 'svc-a' });
    createService({ name: 'svc-b' });
    linkAssetToService('topo-host', 'svc-a');
    addDependency('svc-b', 'svc-a');

    const pack = buildContextPack('topo-host');
    expect(pack.blastRadius.services).toContain('svc-a');
    expect(pack.blastRadius.downstream).toContain('svc-b');
  });

  it('摘要版：字段精简，适合 UI 展示', async () => {
    addAsset({ name: 'sum', type: 'host', addr: '10.0.0.4' });
    const parsed = detectAndParse({ event: 'Alert1', resource: 'sum', severity: 'warning' });
    ingestAlert(parsed[0]!);
    await createAction({ command: 'echo x', actor: HUMAN, target: 'sum' });

    const pack = buildContextPack('sum');
    const summary = summarizeContextPack(pack);
    expect(summary.assetName).toBe('sum');
    expect(summary.openAlertCount).toBeGreaterThanOrEqual(1);
    expect(summary.recentActionCount).toBeGreaterThanOrEqual(1);
    expect(summary.assembledAt).toBeDefined();
  });

  it('空数据资产：各字段为空数组不报错', () => {
    addAsset({ name: 'empty', type: 'host', addr: '10.0.0.5' });
    const pack = buildContextPack('empty');
    expect(pack.openAlerts).toEqual([]);
    expect(pack.recentActions).toEqual([]);
    expect(pack.services).toEqual([]);
    expect(pack.blastRadius).toEqual({ services: [], upstream: [], downstream: [] });
  });
});
