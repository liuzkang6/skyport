/**
 * agent 命令组：签发 / 查看 / 暂停 / 吊销 + agent run（AI 一站式）。
 * key 只在 create 输出一次；M2 无轮换命令（spec 范围），轮换 = revoke + 重建。
 */
import { Command, Option } from 'commander';
import { getConfig } from '../../config/config';
import {
  createAgent,
  getAgent,
  listAgents,
  resolveActor,
  setAgentStatus,
} from '../../services/agents';
import { agentRun } from '../../services/actions';
import { RISK_LEVELS, type RiskLevel } from '../../services/risk';
import {
  printJson,
  renderAgentDetail,
  renderAgentList,
  renderActionResult,
  renderIssuedKey,
} from '../render';

interface CreateAgentOptions {
  readonly name: string;
  readonly assets: readonly string[];
  readonly riskCeiling?: string | undefined;
  readonly autoExecLow?: boolean | undefined;
  readonly expires?: string | undefined;
}

interface RunOptions {
  readonly exec: string;
  readonly target?: string | undefined;
  readonly reason?: string | undefined;
  readonly riskHint?: string | undefined;
  readonly waitSeconds?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly json?: boolean | undefined;
}

function splitAssets(raw: readonly string[]): string[] {
  return raw.flatMap((entry) => entry.split(',')).map((item) => item.trim()).filter((item) => item.length > 0);
}

export function buildAgentCommand(): Command {
  const agent = new Command('agent').description('AI 调用方身份：签发 key / 权限三件套 / 状态管理');

  const create = agent.command('create').description('创建 agent 并签发 API key（key 只显示一次）');
  create
    .requiredOption('--name <name>', 'agent 名（全局唯一）')
    .requiredOption('--assets <patterns>', '资产范围，逗号分隔可重复（* 通配，本机用 local）', (value: string, previous: readonly string[]) => [...previous, value], [])
    .addOption(new Option('--risk-ceiling <level>', '风险上限').choices([...RISK_LEVELS]).default('medium'))
    .option('--auto-exec-low', '允许低危行动自动执行（需策略 autoExecLowRisk 同时开启）')
    .option('--expires <iso>', '到期时间（ISO 8601，如 2026-12-31T00:00:00Z）')
    .action((options: CreateAgentOptions) => {
      const issued = createAgent({
        name: options.name,
        assetPatterns: splitAssets(options.assets),
        riskCeiling: (options.riskCeiling ?? 'medium') as RiskLevel,
        autoExecLow: options.autoExecLow === true,
        expiresAt: options.expires,
      });
      process.stdout.write(renderIssuedKey(issued));
    });

  agent
    .command('list')
    .description('agent 列表')
    .option('--json', '机器可读输出')
    .action((options: { json?: boolean | undefined }) => {
      const agents = listAgents();
      if (options.json === true) printJson(agents);
      else process.stdout.write(renderAgentList(agents));
    });

  agent
    .command('show <target>')
    .description('agent 详情（target 为 name 或 id；不含 key）')
    .option('--json', '机器可读输出')
    .action((target: string, options: { json?: boolean | undefined }) => {
      const found = getAgent(target);
      if (options.json === true) printJson(found);
      else process.stdout.write(renderAgentDetail(found));
    });

  agent
    .command('pause <target>')
    .description('暂停（冻结调用，可恢复：重新 pause 之外需重新激活——M2 用 active 恢复命令略）')
    .action((target: string) => {
      const updated = setAgentStatus(target, 'paused');
      process.stdout.write(`已暂停 ${updated.name}（所有调用立即被拒）\n`);
    });

  agent
    .command('activate <target>')
    .description('恢复被暂停的 agent')
    .action((target: string) => {
      const updated = setAgentStatus(target, 'active');
      process.stdout.write(`已恢复 ${updated.name}\n`);
    });

  agent
    .command('revoke <target>')
    .description('吊销（永久，key 立即作废）')
    .action((target: string) => {
      const updated = setAgentStatus(target, 'revoked');
      process.stdout.write(`已吊销 ${updated.name}（不可恢复；如需再授权请新建 agent）\n`);
    });

  const run = agent.command('run').description('AI 一站式：创建行动 → 等审批/自动执行 → 返回结果');
  run
    .requiredOption('--exec <command>', '要执行的命令（引号内空格会保留）')
    .option('--target <asset>', '目标资产（缺省本机）')
    .option('--reason <text>', '行动理由')
    .addOption(new Option('--risk-hint <level>', '自报风险（只升不降）').choices([...RISK_LEVELS]))
    .option('--wait-seconds <seconds>', '等待审批的超时秒数', '120')
    .option('--api-key <key>', 'API key（缺省读 SKYPORT_API_KEY）')
    .option('--json', '机器可读输出')
    .action(async (options: RunOptions) => {
      const apiKey = options.apiKey ?? getConfig().apiKey;
      const actor = resolveActor(apiKey);
      const waitMs = Math.max(0, Number(options.waitSeconds ?? '120')) * 1_000;
      const result = await agentRun(
        {
          command: options.exec,
          actor,
          target: options.target,
          reason: options.reason,
          riskHint: options.riskHint as RiskLevel | undefined,
        },
        waitMs,
      );
      if (options.json === true) printJson(result);
      else process.stdout.write(renderActionResult(result));
    });

  return agent;
}
