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
  type ActionResult,
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

/** 顶层人工命令：approve / reject（可批量）/ cancel（禁止带 key） */
export function buildApprovalCommands(program: Command): void {
  program
    .command('approve <ids...>')
    .description('批准并立即执行 pending 行动（可批量，只允许人）')
    .option('--json', '机器可读输出')
    .action(async (ids: readonly string[], options: { json?: boolean | undefined }) => {
      const actor = requireHumanActor(getConfig().apiKey);
      await processBatch(ids, options.json === true, async (id) => {
        const result = await approveAction(id, actor);
        return { id, ok: true, result };
      });
    });

  program
    .command('reject <ids...>')
    .description('否决 pending 行动（可批量，只允许人）')
    .option('--note <text>', '否决理由')
    .action(async (ids: readonly string[], options: { note?: string | undefined }) => {
      const actor = requireHumanActor(getConfig().apiKey);
      await processBatch(ids, false, async (id) => {
        const updated = rejectAction(id, actor, options.note);
        return { id, ok: true, result: undefined, message: `已否决 ${updated.id}` };
      });
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

interface BatchOutcome {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: ActionResult | undefined;
  readonly message?: string | undefined;
}

/** 批量处理：逐条执行逐条输出，单条失败不中断，结束后有失败则非零退出 */
async function processBatch(
  ids: readonly string[],
  json: boolean,
  handle: (id: string) => Promise<BatchOutcome>,
): Promise<void> {
  const outcomes: BatchOutcome[] = [];
  for (const id of ids) {
    try {
      const outcome = await handle(id);
      outcomes.push(outcome);
      if (!json) {
        if (outcome.result !== undefined) process.stdout.write(renderActionResult(outcome.result));
        else if (outcome.message !== undefined) process.stdout.write(`${outcome.message}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ id, ok: false });
      if (!json) process.stdout.write(`✕ ${id} 失败：${message}\n`);
    }
  }
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  if (json) printJson({ outcomes: outcomes.map(({ id, ok }) => ({ id, ok })), failed });
  if (failed > 0) throw new Error(`批量操作：${failed}/${ids.length} 条失败（其余已处理）`);
}
