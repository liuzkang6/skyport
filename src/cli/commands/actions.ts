/**
 * action 命令组与顶层审批/直通命令（spec/governance-loop/spec.md 接口表）。
 * 身份约定：action create 以 human 或 agent 身份均可；approve/reject/cancel/run 只允许 human。
 */
import { Command, Option } from 'commander';
import { getConfig } from '../../config/config';
import { requireHumanActor, resolveActor, type ActorRef } from '../../services/agents';
import {
  ACTION_STATUSES,
  approveAction,
  cancelAction,
  createAction,
  getAction,
  getActionEvents,
  listActions,
  rejectAction,
  runDirect,
  type ActionStatus,
} from '../../services/actions';
import { getLastExecution } from '../../services/action-exec';
import { RISK_LEVELS, type RiskLevel } from '../../services/risk';
import { printJson, renderActionDetail, renderActionResult, renderActionList } from '../render';

interface CreateOptions {
  readonly exec: string;
  readonly target?: string | undefined;
  readonly reason?: string | undefined;
  readonly riskHint?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly json?: boolean | undefined;
}

interface ListOptions {
  readonly status?: string | undefined;
  readonly json?: boolean | undefined;
}

function currentApiKey(override: string | undefined): string | undefined {
  return override ?? getConfig().apiKey;
}

export function buildActionCommand(): Command {
  const action = new Command('action').description('行动台账：登记 / 查询');

  const create = action.command('create').description('登记行动（AI 请带 --api-key 或设 SKYPORT_API_KEY）');
  create
    .requiredOption('--exec <command>', '要执行的命令')
    .option('--target <asset>', '目标资产（缺省本机；host/cluster 走 SSH）')
    .option('--reason <text>', '行动理由')
    .addOption(new Option('--risk-hint <level>', '自报风险（只升不降）').choices([...RISK_LEVELS]))
    .option('--api-key <key>', 'API key（缺省读 SKYPORT_API_KEY；不带即 human 身份）')
    .option('--json', '机器可读输出')
    .action(async (options: CreateOptions) => {
      const actor: ActorRef = resolveActor(currentApiKey(options.apiKey));
      const result = await createAction({
        command: options.exec,
        actor,
        target: options.target,
        reason: options.reason,
        riskHint: options.riskHint as RiskLevel | undefined,
      });
      if (options.json === true) printJson(result);
      else process.stdout.write(renderActionResult(result));
    });

  const list = action.command('list').description('行动看板');
  list
    .addOption(new Option('--status <status>', '按状态过滤').choices([...ACTION_STATUSES]))
    .option('--json', '机器可读输出')
    .action((options: ListOptions) => {
      const actions = listActions(options.status as ActionStatus | undefined);
      if (options.json === true) printJson(actions);
      else process.stdout.write(renderActionList(actions));
    });

  action
    .command('show <id>')
    .description('行动详情：命令 / 风险 / 事件流 / 执行结果')
    .option('--json', '机器可读输出')
    .action((id: string, options: { json?: boolean | undefined }) => {
      const found = getAction(id);
      if (options.json === true) {
        printJson({ action: found, events: getActionEvents(id), execution: getLastExecution(id) });
        return;
      }
      process.stdout.write(renderActionDetail(found, getActionEvents(id), getLastExecution(id)));
    });

  return action;
}

/** 顶层人工命令：approve / reject / cancel（禁止带 key） */
export function buildApprovalCommands(program: Command): void {
  program
    .command('approve <id>')
    .description('批准并立即执行一条 pending 行动（只允许人）')
    .option('--json', '机器可读输出')
    .action(async (id: string, options: { json?: boolean | undefined }) => {
      const actor = requireHumanActor(getConfig().apiKey);
      const result = await approveAction(id, actor);
      if (options.json === true) printJson(result);
      else process.stdout.write(renderActionResult(result));
    });

  program
    .command('reject <id>')
    .description('否决一条 pending 行动（只允许人）')
    .option('--note <text>', '否决理由')
    .action((id: string, options: { note?: string | undefined }) => {
      const actor = requireHumanActor(getConfig().apiKey);
      const updated = rejectAction(id, actor, options.note);
      process.stdout.write(`已否决 ${updated.id}（${updated.command.slice(0, 60)}）\n`);
    });

  program
    .command('cancel <id>')
    .description('取消一条 pending 行动（只允许人）')
    .action((id: string) => {
      const actor = requireHumanActor(getConfig().apiKey);
      const updated = cancelAction(id, actor);
      process.stdout.write(`已取消 ${updated.id}\n`);
    });

  const run = program.command('run').description('人自用直通：免审批执行（风险照算照记，全程留痕）');
  run
    .requiredOption('--exec <command>', '要执行的命令')
    .option('--target <asset>', '目标资产（缺省本机）')
    .option('--reason <text>', '行动理由')
    .option('--json', '机器可读输出')
    .action(async (options: CreateOptions) => {
      const actor = requireHumanActor(currentApiKey(options.apiKey));
      const result = await runDirect({
        command: options.exec,
        actor,
        target: options.target,
        reason: options.reason,
      });
      if (options.json === true) printJson(result);
      else process.stdout.write(renderActionResult(result));
    });
}
