/**
 * 云 CLI 可操作（PRD v0.3.x）：cloud-account 资产经网关用云 CLI 执行。
 * 原理：cloud-account 资产不直连——控制机上装的云 CLI（aliyun/aws/gcloud）
 * 是命令本身，executor 只负责执行它。云凭证走保险箱注入。
 */
import { createError, ERROR_CODES } from '../errors/errors';
import { resolveSecretRefs } from './vault';
import type { Asset } from './assets';

export interface CloudTargetSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** 支持的云 CLI 工具 */
const CLOUD_CLI_TOOLS: Readonly<Record<string, string>> = {
  'aliyun': 'aliyun',
  'aws': 'aws',
  'gcloud': 'gcloud',
  'az': 'az',
};

/** 从云账户资产解析 CLI 工具与参数（cloud-account → CLI 命令前缀） */
export function buildCloudTargetSpec(asset: Asset, tokens: readonly string[]): CloudTargetSpec {
  if (asset.type !== 'cloud-account') {
    throw createError(ERROR_CODES.ACTION_INVALID, `非云账户资产不能用此路径: ${asset.name}`, {
      context: { asset: asset.name, type: asset.type },
    });
  }

  // 从标签推断云厂商 CLI（label: cloud=aliyun/aws/gcp/azure）
  const cloud = asset.labels.cloud ?? '';
  const cli = CLOUD_CLI_TOOLS[cloud];
  if (cli === undefined) {
    throw createError(ERROR_CODES.ACTION_INVALID,
      `云账户 ${asset.name} 未指定有效 cloud 标签（cloud=aliyun/aws/gcloud/az）`, {
        context: { asset: asset.name, cloud },
      });
  }

  // 用户命令的 tokens 就是 CLI 参数（凭证已在 executor 层通过保险箱注入 env）
  return { command: cli, args: tokens };
}

/** 检查命令是否包含 {{secret:}} 引用，提示用户走保险箱 */
export function checkSecretInjection(tokens: readonly string[]): void {
  for (const token of tokens) {
    if (/\{\{secret:[^}]+\}\}/.test(token)) {
      // 引用会在 executor spawn 前解析——这里只做存在性检查
      resolveSecretRefs(token);
    }
  }
}
