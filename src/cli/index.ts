/**
 * skyport CLI 入口 —— 全局唯一 catch 处（AGENTS.md §3）。
 * 职责：生成 traceId → 装配 logger/config → 解析命令 → 统一格式化错误、统一决定退出码。
 * 全项目只有本文件允许 process.exit。
 */
import { randomUUID } from 'node:crypto';
import { CommanderError, Command } from 'commander';
import pkg from '../../package.json';
import { appendLineSync } from '../adapters/fs';
import { getConfig, loadConfig } from '../config/config';
import { isSkyportError, type SkyportError } from '../errors/errors';
import { formatLogEntry, rootLogger, type LogSink } from '../logger/logger';
import { runDoctor } from '../services/doctor';

/** 退出码约定：0 成功；1 未知错误；2 用法错误；3-7 按错误域（config/exec/fs/network/permission） */
const EXIT_OK = 0;
const EXIT_UNKNOWN = 1;
const EXIT_USAGE = 2;

const EXIT_BY_DOMAIN: readonly (readonly [string, number])[] = [
  ['SKYPORT_CONFIG_', 3],
  ['SKYPORT_EXEC_', 4],
  ['SKYPORT_FS_', 5],
  ['SKYPORT_NETWORK_', 6],
  ['SKYPORT_PERMISSION_', 7],
];

/** commander 自身展示 help/version 也走 exitOverride 抛出，这两类视为正常退出 */
const COMMANDER_OK_CODES: ReadonlySet<string> = new Set<string>([
  'commander.help',
  'commander.version',
  'commander.helpDisplayed',
]);

function exitCodeForError(error: unknown): number {
  if (error instanceof CommanderError) {
    const code = error.code;
    return COMMANDER_OK_CODES.has(code) ? EXIT_OK : EXIT_USAGE;
  }
  if (!isSkyportError(error)) return EXIT_UNKNOWN;
  for (const [prefix, code] of EXIT_BY_DOMAIN) {
    if (error.type.startsWith(prefix)) return code;
  }
  return EXIT_UNKNOWN;
}

function formatErrorForCli(error: unknown): string {
  if (error instanceof CommanderError) return ''; // commander 已自行输出，不重复打印
  if (isSkyportError(error)) return formatSkyportError(error);
  const inner = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return `[skyport] 未知错误: ${inner}`;
}

function formatSkyportError(error: SkyportError): string {
  const lines = [`[skyport] ${error.type}: ${error.message}`];
  if (Object.keys(error.context).length > 0) {
    lines.push(`  上下文: ${JSON.stringify(error.context)}`);
  }
  let cause: unknown = error.cause;
  for (let depth = 0; cause instanceof Error && depth < 5; depth += 1) {
    lines.push(`  由 ${cause.name}: ${cause.message}`);
    cause = cause.cause;
  }
  return lines.join('\n');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** help/version 是"正常退出"而不是错误，不应记 ERROR 日志 */
function isNormalCommanderExit(error: unknown): boolean {
  return error instanceof CommanderError && COMMANDER_OK_CODES.has(error.code);
}

function createFileSink(logFile: string): LogSink {
  return (entry) => {
    try {
      appendLineSync(logFile, formatLogEntry(entry));
    } catch (error) {
      // 落盘失败不阻断 CLI 主流程，向 stderr 提示后继续
      process.stderr.write(`[skyport] 日志落盘失败: ${describe(error)}\n`);
    }
  };
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('skyport')
    .description('skyport —— AI 运维行动与治理平台 CLI（行动登记 / 审批 / 受控执行 / 审计）')
    .version(pkg.version);
  // 把 commander 默认的 process.exit 收回来，统一交给本文件唯一的 catch 处理
  program.exitOverride();

  program
    .command('doctor')
    .description('环境自检：运行时 / 配置 / 项目配置文件')
    .action(async () => {
      const report = await runDoctor();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ok) throw new Error('doctor 存在未通过项，详见上方报告');
    });

  program
    .command('config')
    .description('打印生效配置（优先级：项目配置 > 环境变量 > 默认值）')
    .action(() => {
      process.stdout.write(`${JSON.stringify(getConfig(), null, 2)}\n`);
    });

  return program;
}

async function bootstrap(): Promise<number> {
  // traceId 在顶层生成，注入 rootLogger 后贯穿全部日志
  const traceId = randomUUID().slice(0, 8);
  const config = loadConfig();
  rootLogger.configure({ level: config.logLevel, traceId });
  if (config.logFile !== undefined) {
    rootLogger.configure({ fileSink: createFileSink(config.logFile) });
  }
  const program = buildProgram();
  await program.parseAsync(process.argv);
  return EXIT_OK;
}

bootstrap()
  .then((exitCode) => process.exit(exitCode))
  .catch((error: unknown) => {
    if (!isNormalCommanderExit(error)) {
      rootLogger.error('CLI 执行失败', { error: describe(error) });
    }
    const text = formatErrorForCli(error);
    if (text !== '') process.stderr.write(`${text}\n`);
    process.exit(exitCodeForError(error));
  });
