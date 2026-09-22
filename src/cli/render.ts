/**
 * CLI 文本渲染：资产/行动/agent 的人类可读输出。
 * 颜色仅在 stdout 是终端时启用（管道/重定向输出纯文本，保证可 grep）。
 */
import type { IssuedAgent, Agent } from '../services/agents';
import type { Action, ActionEvent, ActionResult } from '../services/actions';
import type { Execution } from '../services/action-exec';
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

const ACTION_STATUS_TEXT: Readonly<Record<string, string>> = {
  pending: '○ 待审批',
  approved: '◐ 已放行',
  executing: '⟳ 执行中',
  success: '● 成功',
  failed: '✕ 失败',
  rejected: '⊘ 已否决',
  cancelled: '– 已取消',
};

const COMMAND_DISPLAY_WIDTH = 60;

function actionStatusText(status: string): string {
  const text = ACTION_STATUS_TEXT[status] ?? status;
  if (status === 'success') return paint(GREEN, text);
  if (status === 'failed') return paint(RED, text);
  if (status === 'pending' || status === 'executing') return paint(YELLOW, text);
  return paint(DIM, text);
}

/** 发起者显示：agent 用名字（红队 U2），已删除/无名字回退 ID */
function actorLabel(action: Action): string {
  if (action.actorType === 'human') return `human:${action.actorId}`;
  return `agent:${action.actorName ?? `${action.actorId}（已删除）`}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 看板与值守共用的行动行渲染（红队 U1/U3：命令截断必提示、理由必显示） */
export function renderActionLine(action: Action): string {
  const target = action.targetKind === 'local' ? '本机' : action.targetName;
  const truncated = action.command.length > COMMAND_DISPLAY_WIDTH;
  const command = truncated
    ? `${truncate(action.command, COMMAND_DISPLAY_WIDTH)} ${paint(DIM, `（skyport action show ${action.id} 看全文）`)}`
    : action.command;
  const reason = action.reason === undefined ? '' : `  ${paint(DIM, truncate(`理由: ${action.reason}`, 44))}`;
  return [
    `${action.id}`,
    actionStatusText(action.status),
    paint(YELLOW, action.riskLevel),
    paint(DIM, `${actorLabel(action)} → ${target}`),
    command,
    paint(DIM, action.createdAt.slice(5, 16).replace('T', ' ')),
  ]
    .join('  ')
    .concat(reason);
}

export function renderActionList(actions: readonly Action[], hasMore = false): string {
  if (actions.length === 0) return '暂无行动。skyport action create 登记一条，或 skyport run 直通执行。\n';
  const lines = [`行动看板（共 ${actions.length} 条${hasMore ? '，仅显示最近一页' : ''}）`, ''];
  for (const action of actions) {
    lines.push(`  ${renderActionLine(action)}`);
  }
  if (hasMore) {
    lines.push('', paint(DIM, '已达页大小上限：用 --agent/--target/--since/--offset 缩小或翻页。'));
  }
  return `${lines.join('\n')}\n`;
}

export function renderActionDetail(
  action: Action,
  events: readonly ActionEvent[],
  execution: Execution | undefined,
): string {
  const lines = [
    `行动 ${action.id}  ${actionStatusText(action.status)}`,
    `  命令:     ${action.command}`,
    `  目标:     ${action.targetKind === 'local' ? '本机' : `${action.targetName}（SSH）`}`,
    `  风险:     ${paint(YELLOW, action.riskLevel)}（来源 ${action.riskSource}）`,
    `  理由:     ${action.reason ?? '未填写'}`,
    `  发起者:   ${actorLabel(action)}`,
    `  创建时间: ${action.createdAt}`,
  ];
  if (events.length > 0) {
    lines.push('', '事件流:');
    for (const event of events) {
      lines.push(`  ${paint(DIM, event.createdAt.slice(5, 19).replace('T', ' '))}  ${event.event}  ${paint(DIM, `${event.actorType}:${event.actorId}`)}`);
    }
  }
  if (execution !== undefined) {
    lines.push('', '最近执行:');
    const attempts = execution.attempts > 1 ? paint(YELLOW, `  尝试 ${execution.attempts} 次`) : '';
    lines.push(
      `  结果: ${execution.ok ? paint(GREEN, '成功') : paint(RED, '失败')}  退出码 ${execution.exitCode ?? '-'}  耗时 ${execution.durationMs}ms${execution.timedOut ? paint(RED, '  [超时]') : ''}${attempts}`,
    );
    if (execution.stdout.length > 0) {
      lines.push(`  stdout: ${truncate(execution.stdout, 200)}${execution.stdoutTruncated ? paint(YELLOW, '（已截断）') : ''}`);
    }
    if (execution.stderr.length > 0) {
      lines.push(`  stderr: ${truncate(execution.stderr, 200)}${execution.stderrTruncated ? paint(YELLOW, '（已截断）') : ''}`);
    }
    if (execution.error !== undefined) lines.push(`  错误:   ${truncate(execution.error, 200)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderActionResult(result: ActionResult): string {
  const { action, execution } = result;
  const head = `${action.id}  ${actionStatusText(action.status)}  ${paint(YELLOW, action.riskLevel)}  ${truncate(action.command, 60)}`;
  const lines = [head];
  if (execution === undefined) {
    lines.push(paint(DIM, '等待人工审批：skyport approve ' + action.id + ' / skyport reject ' + action.id));
  } else {
    const attempts = execution.attempts > 1 ? `，尝试 ${execution.attempts} 次` : '';
    lines.push(
      `  ${execution.ok ? paint(GREEN, `执行成功（${execution.durationMs}ms，退出码 ${execution.exitCode ?? '-'}${attempts}）`) : paint(RED, `执行失败（${truncate(execution.error ?? execution.stderr, 120)}${attempts}）`)}`,
    );
    if (execution.stdout.length > 0) lines.push(`  stdout: ${truncate(execution.stdout, 300)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderIssuedKey(issued: IssuedAgent): string {
  const { agent, plaintextKey } = issued;
  return [
    paint(GREEN, `agent ${agent.name}（${agent.id}）已创建`),
    '',
    `  API Key（只显示这一次，请立即保存到安全位置）:`,
    `  ${plaintextKey}`,
    '',
    paint(DIM, `  权限：风险上限 ${agent.riskCeiling} · 资产范围 ${agent.assetPatterns.join(', ')} · scopes ${agent.scopes.join(', ')}`),
    paint(DIM, '  AI 调用方式：skyport agent run --api-key <key> --exec "..." 或设 SKYPORT_API_KEY'),
    '',
  ].join('\n');
}

export function renderAgentList(agents: readonly Agent[]): string {
  if (agents.length === 0) return '暂无 agent。skyport agent create --name x --assets "prod-*" --risk-ceiling medium\n';
  const lines = [`agent 列表（共 ${agents.length} 个）`, ''];
  for (const agent of agents) {
    const status =
      agent.status === 'active' ? paint(GREEN, '● active') : agent.status === 'paused' ? paint(YELLOW, '◐ paused') : paint(RED, '✕ revoked');
    // 红队 S15：key 提示串只在 agent show 单查时展示，列表不显示
    lines.push(
      `  ${agent.name}  ${status}  上限 ${paint(YELLOW, agent.riskCeiling)}  资产 ${agent.assetPatterns.join(',')}  ${agent.scopes.includes('auto-exec-low') ? paint(GREEN, 'auto-low') : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderAgentDetail(agent: Agent): string {
  return [
    `agent ${agent.name}（${agent.id}）`,
    `  状态:     ${agent.status}`,
    `  key 提示: ${agent.keyHint}（明文不可再查）`,
    `  风险上限: ${agent.riskCeiling}`,
    `  资产范围: ${agent.assetPatterns.join('、')}`,
    `  scopes:   ${agent.scopes.join('、')}`,
    `  到期:     ${agent.expiresAt ?? '永久'}`,
    `  创建时间: ${agent.createdAt}`,
  ]
    .join('\n')
    .concat('\n');
}
