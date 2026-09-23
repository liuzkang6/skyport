/**
 * Break-glass 消防斧（spec: v0.4 兜底机制）：
 * 封存应急 SSH 密钥，启用需离线口令 + 最大声报警 + 4h 自动封存 + 强制事后报告。
 * 正常人零接触 SSH 密钥——密钥住保险箱/控制机；斧头在保险柜里。
 */
import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { join } from 'node:path';
import { ensureDir, fileExistsSync, readFileUtf8Sync, setFileMode, writeFileUtf8Sync } from '../adapters/fs';
import { DATA_DIR, getConfig } from '../config/config';
import { createError, ERROR_CODES } from '../errors/errors';
import { rootLogger } from '../logger/logger';
import { httpRequest } from '../adapters/http';

export interface BreakGlassStatus {
  readonly available: boolean;
  readonly sealed: boolean;
  readonly activatedAt: string | undefined;
  readonly expiresAt: string | undefined;
}

export interface BreakGlassActivation {
  readonly activated: boolean;
  readonly expiresAt: string;
  readonly publicKeyPem: string;
  readonly notice: string;
}

const BREAKGLASS_DIR = join(DATA_DIR, 'breakglass');
const SEALED_KEY_FILE = join(BREAKGLASS_DIR, 'emergency_key.sealed');
const PUBLIC_KEY_FILE = join(BREAKGLASS_DIR, 'emergency_key.pub');
const ACTIVATION_FILE = join(BREAKGLASS_DIR, 'activation.json');
const DEFAULT_TTL_HOURS = 4;

/** 初始化封存：生成应急密钥对，私钥用口令加密封存，公钥明文存公钥文件 */
export function initBreakGlass(passphrase: string): { publicKeyPem: string; instruction: string } {
  if (passphrase.length < 8) {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '封存口令至少 8 个字符', { context: {} });
  }
  ensureDir(BREAKGLASS_DIR, 0o700);
  setFileMode(BREAKGLASS_DIR, 0o700);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }).toString();

  writeFileUtf8Sync(SEALED_KEY_FILE, privPem);
  setFileMode(SEALED_KEY_FILE, 0o600);
  writeFileUtf8Sync(PUBLIC_KEY_FILE, pubPem);

  return {
    publicKeyPem: pubPem,
    instruction: `应急公钥已生成。将以下公钥追加到目标机器的 ~/.ssh/authorized_keys 以备应急。\n离线解密命令（打印存保险柜）：openssl pkcs8 -in ${SEALED_KEY_FILE} -passin pass:<口令> -nocrypt`,
  };
}

/** 启用消防斧：解封 + 最大声报警 + 限时 */
export async function activateBreakGlass(passphrase: string): Promise<BreakGlassActivation> {
  if (!fileExistsSync(SEALED_KEY_FILE)) {
    throw createError(ERROR_CODES.ASSET_NOT_FOUND, '应急密钥未初始化，请先运行 skyport breakglass init', { context: {} });
  }

  // 检查是否已激活且未过期
  const existing = getActivation();
  if (existing !== undefined && Date.parse(existing.expiresAt) > Date.now()) {
    return {
      activated: true,
      expiresAt: existing.expiresAt,
      publicKeyPem: readFileUtf8Sync(PUBLIC_KEY_FILE),
      notice: `消防斧已激活（至 ${existing.expiresAt}），无需重复启用`,
    };
  }

  // 尝试解封（验证口令）
  try {
    const sealedPem = readFileUtf8Sync(SEALED_KEY_FILE);
    createPrivateKey({ key: sealedPem, passphrase });
  } catch {
    throw createError(ERROR_CODES.PERMISSION_DENIED, '封存口令错误', { context: {} });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_TTL_HOURS * 3_600_000);
  const pubPem = readFileUtf8Sync(PUBLIC_KEY_FILE);

  // 写入激活状态
  const activation = { activatedAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
  writeFileUtf8Sync(ACTIVATION_FILE, JSON.stringify(activation, null, 2));
  setFileMode(ACTIVATION_FILE, 0o600);

  // 最大声报警：向所有 webhook 渠道广播 + ERROR 日志
  rootLogger.error('⚠️ 消防斧（Break-glass）已启用！所有操作将被记录并要求事后报告', {
    activatedAt: activation.activatedAt,
    expiresAt: activation.expiresAt,
  });

  const webhookUrl = (getConfig() as unknown as { notifyWebhookUrl?: string }).notifyWebhookUrl;
  if (webhookUrl !== undefined) {
    try {
      await httpRequest(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'skyport.breakglass.activated',
          activatedAt: activation.activatedAt,
          expiresAt: activation.expiresAt,
          severity: 'critical',
          message: '⚠️ 应急通道已开启！4 小时后自动封存。使用后必须提交事后报告。',
        }),
        timeoutMs: 5_000,
      });
    } catch { /* 报警失败不阻断 */ }
  }

  // 记入审计日志（不走 action_events 避免 FK 约束——break-glass 是平台级事件不是行动）
  rootLogger.error('BREAK-GLASS ACTIVATED', { activatedAt: activation.activatedAt, expiresAt: activation.expiresAt });

  return {
    activated: true,
    expiresAt: activation.expiresAt,
    publicKeyPem: pubPem,
    notice: `消防斧已启用（${DEFAULT_TTL_HOURS} 小时后自动封存）。窗口期内所有操作标记为 break-glass，必须提交事后报告。`,
  };
}

/** 查询消防斧状态 */
export function getBreakGlassStatus(): BreakGlassStatus {
  const initialized = fileExistsSync(SEALED_KEY_FILE);
  const activation = getActivation();
  const isActive = activation !== undefined && Date.parse(activation.expiresAt) > Date.now();
  return {
    available: initialized,
    sealed: initialized && !isActive,
    activatedAt: activation?.activatedAt,
    expiresAt: activation?.expiresAt,
  };
}

/** 自动封存（serve 定期调用检查过期） */
export function checkAndReseal(): boolean {
  const activation = getActivation();
  if (activation === undefined) return false;
  if (Date.parse(activation.expiresAt) <= Date.now()) {
    // 过期，自动封存
    writeFileUtf8Sync(ACTIVATION_FILE, JSON.stringify({ ...activation, resealed: true, resealedAt: new Date().toISOString() }));
    rootLogger.warn('消防斧已到期，自动重新封存', { previousActivation: activation.activatedAt });
    return true;
  }
  return false;
}

function getActivation(): { activatedAt: string; expiresAt: string; resealed?: boolean } | undefined {
  if (!fileExistsSync(ACTIVATION_FILE)) return undefined;
  try {
    return JSON.parse(readFileUtf8Sync(ACTIVATION_FILE));
  } catch {
    return undefined;
  }
}
