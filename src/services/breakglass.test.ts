import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../adapters/db';
import { DATA_DIR, resetConfigCache } from '../config/config';
import { isSkyportError } from '../errors/errors';
import { activateBreakGlass, getBreakGlassStatus, initBreakGlass, checkAndReseal } from './breakglass';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-bg-'));
  process.env.SKYPORT_DB_PATH = join(tempDir, 'skyport.db');
  resetConfigCache();
});

afterEach(async () => {
  closeDb();
  delete process.env.SKYPORT_DB_PATH;
  resetConfigCache();
  // 清理 breakglass 目录
  const bgDir = join(DATA_DIR, 'breakglass');
  if (existsSync(bgDir)) {
    await rm(bgDir, { recursive: true, force: true });
  }
  await rm(tempDir, { recursive: true, force: true });
});

function cap(fn: () => unknown): string {
  try { fn(); } catch (e) { if (isSkyportError(e)) return e.type; throw e; }
  throw new Error('应抛错');
}

describe('Break-glass 消防斧（v0.4 兜底）', () => {
  const passphrase = 'emergency-pass-123';

  it('正常路径：init 生成密钥对，公钥明文私钥加密', () => {
    const result = initBreakGlass(passphrase);
    expect(result.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(result.instruction).toContain('openssl');
    // 私钥文件存在且加密
    const sealedPath = join(DATA_DIR, 'breakglass', 'emergency_key.sealed');
    expect(existsSync(sealedPath)).toBe(true);
    const sealed = readFileSync(sealedPath, 'utf8');
    expect(sealed).toContain('ENCRYPTED');
  });

  it('失败路径-弱口令：init 拒绝 <8 字符', () => {
    expect(cap(() => initBreakGlass('short'))).toBe('SKYPORT_PERMISSION_DENIED');
  });

  it('正常路径：activate 用正确口令启用，返回公钥与到期时间', async () => {
    initBreakGlass(passphrase);
    const result = await activateBreakGlass(passphrase);
    expect(result.activated).toBe(true);
    expect(result.expiresAt).toBeDefined();
    expect(result.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(result.notice).toContain('事后报告');
  });

  it('失败路径-错误口令：activate 拒绝', async () => {
    initBreakGlass(passphrase);
    expect(await (async () => {
      try { await activateBreakGlass('wrong-password'); } catch (e) { if (isSkyportError(e)) return e.type; throw e; }
      throw new Error('应抛错');
    })()).toBe('SKYPORT_PERMISSION_DENIED');
  });

  it('失败路径-未初始化：activate 报 ASSET_NOT_FOUND', async () => {
    expect(await (async () => {
      try { await activateBreakGlass(passphrase); } catch (e) { if (isSkyportError(e)) return e.type; throw e; }
      throw new Error('应抛错');
    })()).toBe('SKYPORT_ASSET_NOT_FOUND');
  });

  it('状态查询：init 前 unavailable，init 后 sealed，activate 后非 sealed', async () => {
    expect(getBreakGlassStatus().available).toBe(false);

    initBreakGlass(passphrase);
    expect(getBreakGlassStatus().available).toBe(true);
    expect(getBreakGlassStatus().sealed).toBe(true);

    await activateBreakGlass(passphrase);
    expect(getBreakGlassStatus().sealed).toBe(false);
    expect(getBreakGlassStatus().activatedAt).toBeDefined();
  });

  it('自动封存：到期后 checkAndReseal 返回 true', async () => {
    initBreakGlass(passphrase);
    await activateBreakGlass(passphrase);
    // 直改激活文件让过期时间为过去
    const activationPath = join(DATA_DIR, 'breakglass', 'activation.json');
    const activation = JSON.parse(readFileSync(activationPath, 'utf8'));
    activation.expiresAt = new Date(Date.now() - 1000).toISOString();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(activationPath, JSON.stringify(activation));

    expect(checkAndReseal()).toBe(true);
    expect(getBreakGlassStatus().sealed).toBe(true); // 重新封存
  });
});
