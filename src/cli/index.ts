/**
 * skyport CLI 入口 —— 全局唯一 catch 处（AGENTS.md §3）。
 * 职责：生成 traceId → 装配 logger/config → 解析命令 → 统一格式化错误、统一决定退出码。
 * 全项目只有本文件允许 process.exit。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { CommanderError, Command } from 'commander';
// 版本号经 createRequire 解析：src（tsx 运行）与 dist（esbuild 产物）相对深度一致
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
import { getDb } from '../adapters/db';
import { appendLineSync } from '../adapters/fs';
import { getConfig, loadConfig } from '../config/config';
import { isSkyportError, type SkyportError } from '../errors/errors';
import { formatLogEntry, rootLogger, type LogSink } from '../logger/logger';
import { runDoctor } from '../services/doctor';
import { defaultPolicyPath, loadPolicy } from '../services/risk';
import { backupDatabase } from '../services/backup';
import { verifyAuditChain } from '../services/audit-chain';
import { buildAgentCommand } from './commands/agents';
import { buildActionCommand, buildApprovalCommands } from './commands/actions';
import { buildAssetCommand, configureListCommand } from './commands/assets';
import { buildWatchCommand } from './commands/watch';
import { buildUserCommand } from './commands/users';

/** 退出码约定：0 成功；1 未知错误；2 用法错误；3-9 按错误域（config/exec/fs/network/permission/db/asset） */
const EXIT_OK = 0;
const EXIT_UNKNOWN = 1;
const EXIT_USAGE = 2;

const EXIT_BY_DOMAIN: readonly (readonly [string, number])[] = [
  ['SKYPORT_CONFIG_', 3],
  ['SKYPORT_EXEC_', 4],
  ['SKYPORT_FS_', 5],
  ['SKYPORT_NETWORK_', 6],
  ['SKYPORT_PERMISSION_', 7],
  ['SKYPORT_DB_', 8],
  ['SKYPORT_ASSET_', 9],
  ['SKYPORT_AGENT_', 10],
  ['SKYPORT_ACTION_', 11],
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
  const inner = error instanceof Error ? error.message : String(error);
  return `[skyport] 未知错误: ${inner}`;
}

function formatSkyportError(error: SkyportError): string {
  const lines = [`[skyport] ${error.type}: ${error.message}`];
  if (Object.keys(error.context).length > 0) {
    lines.push(`  上下文: ${JSON.stringify(error.context)}`);
  }
  // 红队 S13：底层技术细节默认隐藏（SKYPORT_VERBOSE_ERRORS=true 打开排查）
  if (verboseErrorsEnabled()) {
    let cause: unknown = error.cause;
    for (let depth = 0; cause instanceof Error && depth < 5; depth += 1) {
      lines.push(`  技术细节: ${cause.name}: ${cause.message}`);
      cause = cause.cause;
    }
  }
  return lines.join('\n');
}

function verboseErrorsEnabled(): boolean {
  try {
    return getConfig().verboseErrors === true;
  } catch {
    return false; // 配置本身打不开时更不能让格式化层再炸
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    .command('init')
    .description('初始化数据目录与数据库（skyport.db），打印上手命令')
    .action(() => {
      const config = getConfig();
      getDb(); // 打开即建库即迁移
      process.stdout.write(
        [
          'skyport 初始化完成：',
          `  数据库    ${config.dbPath}（目录 0700 / 文件 0600）`,
          '',
          '接下来可以：',
          '  skyport asset add --name web-01 --type host --addr 10.0.1.11 --label env=prod',
          '  skyport asset import fleet.json',
          '  skyport list                 # 查看资产清单',
          '  skyport asset check web-01   # 连通性检查',
          '  skyport doctor               # 环境自检',
        ]
          .join('\n')
          .concat('\n'),
      );
    });

  program
    .command('backup')
    .description('备份数据库（默认 ~/.skyport/backups，按保留份数自动清理旧备份）')
    .option('--dir <path>', '备份目录（缺省 ~/.skyport/backups；自定义目录不动其权限）')
    .option('--keep <n>', '保留份数（缺省取配置，默认 10）')
    .action(async (options: { dir?: string | undefined; keep?: string | undefined }) => {
      const keep = options.keep === undefined ? getConfig().backupKeep : Number(options.keep);
      if (!Number.isInteger(keep) || keep < 0) throw new Error('--keep 需为非负整数');
      const result = await backupDatabase(options.dir, keep);
      process.stdout.write(
        `已备份 ${result.path}（${result.bytes} 字节${result.pruned > 0 ? `，清理旧备份 ${result.pruned} 份` : ''}）\n`,
      );
    });

  program
    .command('audit')
    .description('审计操作')
    .command('verify')
    .description('校验审计链完整性（任何单条删改都会断链）')
    .action(() => {
      const result = verifyAuditChain();
      if (result.ok) {
        process.stdout.write(`审计链完整（${result.checked} 条记录校验通过）\n`);
      } else {
        process.stdout.write(`审计链断裂！${result.firstViolation?.table} seq=${result.firstViolation?.seq}：${result.firstViolation?.reason}\n`);
        process.exitCode = 1;
      }
    });

  // 裸 skyport list 即资产清单（spec 约定）
  configureListCommand(program.command('list'));
  program.addCommand(buildAssetCommand());
  program.addCommand(buildActionCommand());
  program.addCommand(buildAgentCommand());
  program.addCommand(buildUserCommand());
  buildApprovalCommands(program);
  buildWatchCommand(program);

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
    .description('打印生效配置与安全姿态（优先级：项目配置 > 环境变量 > 默认值）')
    .action(() => {
      const config = getConfig();
      const policy = loadPolicy();
      // 安全姿态可见性（红队 S15）：apiKey 只显示设置状态，策略关键项一目了然
      const view = {
        ...config,
        apiKey: config.apiKey === undefined ? undefined : '***已设置***',
        policy: {
          path: config.policyPath ?? defaultPolicyPath(),
          autoExecLowRisk: policy.autoExecLowRisk,
          rules: policy.rules.length,
          whitelist: policy.whitelist.length,
        },
      };
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
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

// 红队 N1：管道写是异步的，process.exit 会丢弃未冲刷的 stdout 缓冲（管道下 --json 恰好断在 64KiB）。
// 改用 exitCode 让 Node 事件循环自然退出，保证全部输出先落盘/落管道。
bootstrap()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    // 红队 S15：commander 用法错误是人手滑不是故障，只留 commander 自己的输出，不记 ERROR
    if (!(error instanceof CommanderError)) {
      rootLogger.error('CLI 执行失败', { error: describe(error) });
    }
    const text = formatErrorForCli(error);
    if (text !== '') process.stderr.write(`${text}\n`);
    process.exitCode = exitCodeForError(error);
  });
