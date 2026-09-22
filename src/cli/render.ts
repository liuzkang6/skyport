/**
 * CLI 文本渲染：资产清单/详情/检查结果的人类可读输出。
 * 颜色仅在 stdout 是终端时启用（管道/重定向输出纯文本，保证可 grep）。
 */
import type { Asset, AssetCheck, AssetType, CheckResult, ImportSummary } from '../services/assets';

const TYPE_ORDER: readonly AssetType[] = ['host', 'cluster', 'cloud-account'];
const TYPE_LABEL: Readonly<Record<AssetType, string>> = {
  host: '主机',
  cluster: '集群',
  'cloud-account': '云账户',
};

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function paint(color: string, text: string): string {
  return process.stdout.isTTY === true ? `${color}${text}${RESET}` : text;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function statusText(asset: Asset): string {
  if (asset.status === 'up') return paint(GREEN, '● 正常');
  if (asset.status === 'down') return paint(RED, '✕ 异常');
  return paint(YELLOW, '○ 未知');
}

function labelText(asset: Asset, max = 3): string {
  const pairs = Object.entries(asset.labels)
    .slice(0, max)
    .map(([key, value]) => `${key}=${value}`);
  return pairs.join('  ');
}

function lastCheckText(asset: Asset): string {
  if (asset.lastCheckAt === undefined) return paint(DIM, '未检查');
  const base = `${asset.lastCheckAt.slice(0, 19).replace('T', ' ')}`;
  if (asset.status === 'up') {
    return paint(DIM, `${base} · ${asset.lastCheckLatencyMs ?? '?'}ms`);
  }
  return paint(DIM, `${base} · ${asset.lastCheckError ?? '失败'}`);
}

export function renderAssetList(assets: readonly Asset[]): string {
  if (assets.length === 0) {
    return '暂无资产。先用 skyport asset add 登记，或用 skyport asset import <file.json> 批量导入。\n';
  }
  const lines: string[] = [`资产清单（共 ${assets.length} 项）`, ''];
  for (const type of TYPE_ORDER) {
    const group = assets.filter((asset) => asset.type === type);
    if (group.length === 0) continue;
    lines.push(`${TYPE_LABEL[type]}（${group.length}）`);
    for (const asset of group) {
      const parts = [
        `  ${asset.name}`,
        statusText(asset),
        asset.addr ?? paint(DIM, '无地址'),
        labelText(asset),
        lastCheckText(asset),
      ].filter((part) => part.length > 0);
      lines.push(parts.join('   '));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function renderAssetDetail(asset: Asset, checks: readonly AssetCheck[]): string {
  const lines: string[] = [
    `资产 ${asset.name}（${asset.id}）`,
    `  类型:       ${asset.type}`,
    `  状态:       ${statusText(asset)}`,
    `  地址:       ${asset.addr ?? '未登记'}`,
    `  连接模式:   ${asset.connectMode ?? '未设置'}`,
    `  标签:       ${Object.keys(asset.labels).length > 0 ? labelText(asset, 99) : '无'}`,
    `  创建时间:   ${asset.createdAt}`,
    `  最近检查:   ${lastCheckText(asset)}`,
  ];
  if (checks.length > 0) {
    lines.push('', '最近检查历史:');
    for (const check of checks) {
      const outcome = check.ok ? paint(GREEN, '✓ 通') : paint(RED, '✕ 断');
      const latency = check.latencyMs === undefined ? '' : ` ${check.latencyMs}ms`;
      const reason = check.error === undefined ? '' : ` · ${check.error}`;
      lines.push(`  ${outcome}${latency}  ${check.checkedAt}${paint(DIM, reason)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderCheckResult(result: CheckResult): string {
  const { asset } = result;
  const head =
    result.ok === true
      ? paint(GREEN, `● 正常   ${asset.name}  ${result.latencyMs ?? '?'}ms`)
      : paint(RED, `✕ 异常   ${asset.name}  ${result.error ?? '未知原因'}`);
  return `${head}\n${paint(DIM, `状态已记录（${asset.status}），历史见 skyport asset show ${asset.name}`)}\n`;
}

export function renderImportSummary(summary: ImportSummary): string {
  const names = summary.names.join('、');
  return `已导入 ${summary.added} 项资产：${names}\n`;
}
