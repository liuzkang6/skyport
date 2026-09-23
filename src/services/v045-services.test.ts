import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { addAsset, getAsset } from './assets';
import { createAgent } from './agents';
import { recordUsage, getUsageSummary, checkBudgetAlerts } from './usage';
import { installPlugin, listPlugins, setPluginEnabled, uninstallPlugin, getPlugin } from './plugins';
import { recordMetricPoint, computeBaseline, isAnomalous, getBaselines } from './baseline';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-v045-'));
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

describe('Token 用量治理', () => {
  it('正常路径：recordUsage → getUsageSummary 按模型/agent 分组', () => {
    const agent = createAgent({ name: 'usage-test', assetPatterns: ['*'], riskCeiling: 'low', autoExecLow: false });
    recordUsage({ agentId: agent.agent.id, model: 'glm-4', promptTokens: 100, completionTokens: 50, costUsd: 0.01, actionId: undefined });
    recordUsage({ agentId: agent.agent.id, model: 'glm-4', promptTokens: 200, completionTokens: 100, costUsd: 0.02, actionId: undefined });
    const summary = getUsageSummary(24);
    expect(summary.totalPromptTokens).toBe(300);
    expect(summary.totalCompletionTokens).toBe(150);
    expect(summary.byModel['glm-4']).toBeDefined();
    expect(summary.byAgent[agent.agent.id]).toBeDefined();
  });

  it('失败路径-负数用量 → AGENT_INVALID', () => {
    expect(cap(() => recordUsage({ agentId: 'x', model: 'm', promptTokens: -1, completionTokens: 0, costUsd: 0, actionId: undefined }))).toBe('SKYPORT_AGENT_INVALID');
  });

  it('预算告警：超阈值的 agent 被列出', () => {
    const agent = createAgent({ name: 'expensive', assetPatterns: ['*'], riskCeiling: 'low', autoExecLow: false });
    recordUsage({ agentId: agent.agent.id, model: 'gpt-4', promptTokens: 1_000_000, completionTokens: 500_000, costUsd: 100, actionId: undefined });
    const alerts = checkBudgetAlerts(50);
    expect(alerts.some((a) => a.agentId === agent.agent.id)).toBe(true);
  });
});

describe('插件体系骨架', () => {
  it('正常路径：install → list → enable → disable → uninstall', () => {
    installPlugin({ name: 'zabbix', version: '1.0.0', description: 'Zabbix 告警接入', capabilities: ['alert.ingest', 'metrics.fetch'] });
    expect(listPlugins()).toHaveLength(1);

    const enabled = setPluginEnabled('zabbix', true);
    expect(enabled.enabled).toBe(true);

    setPluginEnabled('zabbix', false);
    const plugin = getPlugin('zabbix');
    expect(plugin.enabled).toBe(false);

    uninstallPlugin('zabbix');
    expect(listPlugins()).toHaveLength(0);
  });

  it('失败路径-重名安装 → ASSET_DUPLICATE_NAME', () => {
    installPlugin({ name: 'dup', version: '1.0' });
    expect(cap(() => installPlugin({ name: 'dup', version: '1.0' }))).toBe('SKYPORT_ASSET_DUPLICATE_NAME');
  });

  it('失败路径-不存在 → ASSET_NOT_FOUND', () => {
    expect(cap(() => getPlugin('ghost'))).toBe('SKYPORT_ASSET_NOT_FOUND');
    expect(cap(() => uninstallPlugin('ghost'))).toBe('SKYPORT_ASSET_NOT_FOUND');
  });
});

describe('基线三相训练', () => {
  it('正常路径：积累数据 → computeBaseline → isAnomalous 判异常', () => {
    addAsset({ name: 'base-test', type: 'host', addr: '10.0.0.1' });
    const asset = getAsset('base-test');

    // 积累 20 个数据点（模拟正常范围 50-60）
    for (let i = 0; i < 20; i++) {
      recordMetricPoint(asset.id, 'disk_usage', 50 + (i % 10));
    }
    const baseline = computeBaseline(asset.id, 'disk_usage');
    expect(baseline).toBeDefined();
    expect(baseline!.sampleCount).toBe(20);

    // 正常值：不异常
    const normal = isAnomalous(asset.id, 'disk_usage', 55);
    expect(normal.anomalous).toBe(false);

    // 异常值：超 p95
    const abnormal = isAnomalous(asset.id, 'disk_usage', 95);
    expect(abnormal.anomalous).toBe(true);
  });

  it('样本不足：不计算基线', () => {
    addAsset({ name: 'sparse', type: 'host', addr: '10.0.0.2' });
    const asset = getAsset('sparse');
    recordMetricPoint(asset.id, 'cpu', 50);
    expect(computeBaseline(asset.id, 'cpu')).toBeUndefined();
    expect(isAnomalous(asset.id, 'cpu', 99).anomalous).toBe(false); // 基线未建立
  });

  it('getBaselines 返回资产全部基线', () => {
    addAsset({ name: 'multi', type: 'host', addr: '10.0.0.3' });
    const asset = getAsset('multi');
    for (let i = 0; i < 15; i++) {
      recordMetricPoint(asset.id, 'cpu', 30 + (i % 5));
      recordMetricPoint(asset.id, 'mem', 60 + (i % 5));
    }
    computeBaseline(asset.id, 'cpu');
    computeBaseline(asset.id, 'mem');
    expect(getBaselines(asset.id).length).toBe(2);
  });
});
