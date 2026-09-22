/**
 * action 命令组与顶层审批/直通命令（spec/governance-loop/spec.md 接口表）。
 * 退出码契约（红队 S7/S8）：行动终态 failed → exit 4；批量失败保留最重要失败的域码，不出现"未知错误"。
 */
import { Command, Option } from 'commander';
import { getConfig } from '../../config/config';
import { requireHumanActor, resolveActor, type ActorRef } from '../../services/agents';
import {
  ACTION_STATUSES,
  approveAction,
  cancelAction,
  createAction,
  rejectAction,
  runDirect,
  type ActionResult,
  type ActionStatus,
} from '../../services/actions';
import { getAction, getActionEvents, listActions } from '../../services/action-queries';
import { getLastExecution } from '../../services/action-exec';
import { RISK_LEVELS, type RiskLevel } from '../../services/risk';
import { createError, ERROR_CODES, isSkyportError } from '../../errors/errors';
import { printJson, renderActionDetail, renderActionResult, renderActionList } from '../render';

interface CreateOptions {
  readonly exec: string;
  readonly target?: string | undefined;
  readonly reason?: string | undefined;
  readonly riskHint?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly apiKeyFile?: string | undefined;
  readonly json?: boolean | undefined;
}

interface ListOptions {
  readonly status?: string | undefined;
  readonly agent?: string | undefined;
  readonly target?: string | undefined;
  readonly since?: string | undefined;
  readonly limit?: string | undefined;
  readonly offset?: string | undefined;
  readonly json?: boolean | undefined;
}

function currentApiKey(override: string | undefined): string | undefined {
  return override ?? getConfig().apiKey;
}

/** 行动执行失败 → 统一的 exec 域错误（CLI 退出码 4，红队 S7） */
export function executionFailureOf(result: ActionResult): Error | undefined {
  if (result.action.status !== 'failed') return undefined;
  return createError(ERROR_CODES.EXEC_NON_ZERO, `行动 ${result.action.id} 执行失败`, {
    context: {
      actionId: result.action.id,
      exitCode: result.execution?.exitCode ?? null,
      error: result.execution?.error ?? null,
    },
  });
}

/** 批量操作聚合错误（红队 S8）：优先保留第一条真实域码；纯执行失败汇总为 exec 域 */
export function buildBatchError(
  itemErrors: readonly unknown[],
  executionFailures: number,
  total: number,
): unknown | undefined {
  const first = itemErrors[0];
  if (itemErrors.length > 0) {
    if (isSkyportError(first)) {
      return createError(first.type, `批量操作：${itemErrors.length}/${total} 条失败（详见上方明细）`, {
        cause: first.cause,
        context: { ...first.context, failed: itemErrors.length, total },
      });
    }
    return new Error(`批量操作：${itemErrors.length}/${total} 条失败（详见上方明细）`);
  }
  if (executionFailures > 0) {
    return createError(ERROR_CODES.EXEC_NON_ZERO, `批量操作：${executionFailures}/${total} 条执行失败（详见上方明细）`, {
      context: { failed: executionFailures, total },
    });
  }
  return undefined;
}

/** 输出结果后若执行失败则抛 exec 域错误（退出码 4） */
function report(result: ActionResult, json: boolean): void {
  if (json) printJson(result);
  else process.stdout.write(renderActionResult(result));
  const failure = executionFailureOf(result);
  if (failure !== undefined) throw failure;
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
    .option('--api-key-file <path>', '从文件读 API key（避免 argv 泄露，红队 S11）')
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

  const list = action.command('list').description('行动看板（支持过滤与分页）');
  list
    .addOption(new Option('--status <status>', '按状态过滤').choices([...ACTION_STATUSES]))
    .option('--agent <name>', '按发起者过滤（agent 名字/ID 或 human 用户名）')
    .option('--target <asset>', '按目标资产过滤')
    .option('--since <iso>', '只看此时间之后的行动（ISO 8601）')
    .option('--limit <n>', '页大小（默认 200）', '200')
    .option('--offset <n>', '偏移量（翻页用）', '0')
    .option('--json', '机器可读输出')
    .action((options: ListOptions) => {
      const page = listActions({
        status: options.status as ActionStatus | undefined,
        actor: options.agent,
        target: options.target,
        since: options.since,
        limit: Math.max(1, Number(options.limit ?? '200')),
        offset: Math.max(0, Number(options.offset ?? '0')),
      });
      if (options.json === true) printJson(page);
      else process.stdout.write(renderActionList(page.actions, page.hasMore));
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
    .description('批准并立即执行 pending 行动（可批量，只允许人；执行失败整体退出码 4）')
    .option('--json', '机器可读输出')
    .action(async (ids: readonly string[], options: { json?: boolean | undefined }) => {
      const actor = requireHumanActor(getConfig().apiKey);
      const itemErrors: unknown[] = [];
      let executionFailures = 0;
      for (const id of ids) {
        try {
          if (options.json !== true) process.stdout.write(paintDim(`▶ ${id} 执行中（慢命令请等待，超时上限见配置）…\n`));
          const result = await approveAction(id, actor);
          if (result.action.status === 'failed') executionFailures += 1;
          if (options.json !== true) process.stdout.write(renderActionResult(result));
        } catch (error) {
          itemErrors.push(error);
          if (options.json !== true) {
            const message = error instanceof Error ? error.message : String(error);
            process.stdout.write(`✕ ${id} 失败：${message}\n`);
          }
        }
      }
      if (options.json === true) {
        printJson({ total: ids.length, failed: itemErrors.length, executionFailures });
      }
      const batchError = buildBatchError(itemErrors, executionFailures, ids.length);
      if (batchError !== undefined) throw batchError;
    });

  program
    .command('reject <ids...>')
    .description('否决 pending 行动（可批量，只允许人）')
    .option('--note <text>', '否决理由')
    .option('--json', '机器可读输出')
    .action(async (ids: readonly string[], options: { note?: string | undefined; json?: boolean | undefined }) => {
      const actor = requireHumanActor(getConfig().apiKey);
      const itemErrors: unknown[] = [];
      for (const id of ids) {
        try {
          const updated = rejectAction(id, actor, options.note);
          if (options.json !== true) process.stdout.write(`已否决 ${updated.id}\n`);
        } catch (error) {
          itemErrors.push(error);
          if (options.json !== true) {
            const message = error instanceof Error ? error.message : String(error);
            process.stdout.write(`✕ ${id} 失败：${message}\n`);
          }
        }
      }
      const batchError = buildBatchError(itemErrors, 0, ids.length);
      if (batchError !== undefined) throw batchError;
    });

  program
    .command('cancel <id>')
    .description('取消一条 pending 行动（只允许人）')
    .action((id: string) => {
      const actor = requireHumanActor(getConfig().apiKey);
      const updated = cancelAction(id, actor);
      process.stdout.write(`已取消 ${updated.id}\n`);
    });

  const run = program.command('run').description('人自用直通：免审批执行（风险照算照记，全程留痕；失败退出码 4）');
  run
    .requiredOption('--exec <command>', '要执行的命令')
    .option('--target <asset>', '目标资产（缺省本机）')
    .option('--reason <text>', '行动理由')
    .option('--json', '机器可读输出')
    .action(async (options: CreateOptions) => {
      const actor = requireHumanActor(currentApiKey(options.apiKey));
      if (options.json !== true) process.stdout.write(paintDim('执行中（慢命令请等待）…\n'));
      const result = await runDirect({
        command: options.exec,
        actor,
        target: options.target,
        reason: options.reason,
      });
      report(result, options.json === true);
    });
}

function paintDim(text: string): string {
  return process.stdout.isTTY === true ? `\x1b[2m${text}\x1b[0m` : text;
}
