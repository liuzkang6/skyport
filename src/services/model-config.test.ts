import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../adapters/db';
import { resetConfigCache } from '../config/config';
import {
  deleteModelConfig,
  getModelByName,
  listModelConfigs,
  resolveModelForTier,
  upsertModelConfig,
} from './model-config';
import { getSecret } from './vault';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-modelcfg-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('模型配置中心（spec/llm-seat）', () => {
  it('登记模型：key 入保险箱（AES-GCM），视图永不回传 key', () => {
    const view = upsertModelConfig({
      name: 'glm-flash', baseUrl: 'https://models.example.com/glm/v1/', modelId: 'GLM-5.3-Flash',
      apiKey: 'sk-secret-key-123', tier: 'cheap', enabled: true,
    });
    expect(view.name).toBe('glm-flash');
    expect(view.baseUrl).toBe('https://models.example.com/glm/v1'); // 尾斜杠归一
    expect(JSON.stringify(view)).not.toContain('sk-secret-key-123');

    // key 在保险箱里，可解密取回
    const secret = getSecret('model:glm-flash');
    expect(secret.value).toBe('sk-secret-key-123');
    // 且模型表里不含明文 key（只有保险箱引用名）
    const rawRows = getDb().prepare('SELECT * FROM model_configs').all();
    expect(JSON.stringify(rawRows)).not.toContain('sk-secret-key-123');
  });

  it('更新：同名覆盖（key 版本自增），列表与单查一致', () => {
    upsertModelConfig({ name: 'ds', baseUrl: 'https://a.example/v1', modelId: 'DeepSeek-V4-Flash', apiKey: 'k1', tier: 'strong', enabled: true });
    upsertModelConfig({ name: 'ds', baseUrl: 'https://b.example/v1', modelId: 'DeepSeek-V4-Flash', apiKey: 'k2', tier: 'strong', enabled: false });
    const list = listModelConfigs();
    expect(list).toHaveLength(1);
    expect(list[0]!.baseUrl).toBe('https://b.example/v1');
    expect(list[0]!.enabled).toBe(false);
    expect(getSecret('model:ds').value).toBe('k2');
  });

  it('选型：优先同档，缺档回退任意启用；未配置报错', () => {
    upsertModelConfig({ name: 'cheap-1', baseUrl: 'https://a.example/v1', modelId: 'm1', apiKey: 'k', tier: 'cheap', enabled: true });
    upsertModelConfig({ name: 'strong-1', baseUrl: 'https://b.example/v1', modelId: 'm2', apiKey: 'k', tier: 'strong', enabled: true });

    expect(resolveModelForTier('strong').modelId).toBe('m2');
    expect(resolveModelForTier('cheap').modelId).toBe('m1');

    // 只有 strong 可用时，cheap 档回退到 strong
    upsertModelConfig({ name: 'cheap-1', baseUrl: 'https://a.example/v1', modelId: 'm1', apiKey: 'k', tier: 'cheap', enabled: false });
    expect(resolveModelForTier('cheap').modelId).toBe('m2');
  });

  it('删除：记录与保险箱条目一并清理；不存在时报错', () => {
    upsertModelConfig({ name: 'tmp', baseUrl: 'https://a.example/v1', modelId: 'm', apiKey: 'k', tier: 'cheap', enabled: true });
    deleteModelConfig('tmp');
    expect(listModelConfigs()).toHaveLength(0);
    expect(() => getModelByName('tmp')).toThrow();
    expect(() => deleteModelConfig('tmp')).toThrow();
  });

  it('校验：空名/非法 URL/空 key 拒绝', () => {
    expect(() => upsertModelConfig({ name: '', baseUrl: 'https://a/v1', modelId: 'm', apiKey: 'k', tier: 'cheap', enabled: true })).toThrow();
    expect(() => upsertModelConfig({ name: 'x', baseUrl: 'ftp://a', modelId: 'm', apiKey: 'k', tier: 'cheap', enabled: true })).toThrow();
    expect(() => upsertModelConfig({ name: 'x', baseUrl: 'https://a/v1', modelId: 'm', apiKey: ' ', tier: 'cheap', enabled: true })).toThrow();
  });
});
