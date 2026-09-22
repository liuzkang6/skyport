/**
 * asset 命令组与顶层 list 命令（spec/asset-inventory/spec.md 接口表）。
 * 参数校验双保险：commander requiredOption/choices 挡明显误用，服务层 zod 兜底。
 */
import { Command, Option } from 'commander';
import {
  ASSET_TYPES,
  addAsset,
  checkAsset,
  getAsset,
  getCheckHistory,
  importAssets,
  listAssets,
  parseLabelPairs,
  removeAsset,
  type AssetType,
  type ConnectMode,
} from '../../services/assets';
import {
  printJson,
  renderAssetDetail,
  renderAssetList,
  renderCheckResult,
  renderImportSummary,
} from '../render';

interface ListOptions {
  readonly type?: string | undefined;
  readonly label?: string | undefined;
  readonly json?: boolean | undefined;
}

interface AddOptions {
  readonly name: string;
  readonly type: string;
  readonly addr?: string | undefined;
  readonly connectMode?: string | undefined;
  readonly label: readonly string[];
}

interface TargetOptions {
  readonly json?: boolean | undefined;
}

function collectPair(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

/** list 的选项与行为在 asset list 与顶层 list 之间共享，保证两者输出一致 */
export function configureListCommand(command: Command): Command {
  return command
    .description('资产清单（可用 --type / --label 过滤，--json 供 AI 解析）')
    .option('--type <type>', '按类型过滤')
    .option('--label <pair>', '按标签过滤（key=value）')
    .option('--json', '机器可读输出')
    .action((options: ListOptions) => {
      const labelPairs = options.label === undefined ? {} : parseLabelPairs([options.label]);
      const labelKey = Object.keys(labelPairs)[0];
      const assets = listAssets({
        type: options.type as AssetType | undefined,
        labelKey,
        labelValue: labelKey === undefined ? undefined : labelPairs[labelKey],
      });
      if (options.json === true) printJson(assets);
      else process.stdout.write(renderAssetList(assets));
    });
}

export function buildAssetCommand(): Command {
  const asset = new Command('asset').description('资产台账：登记 / 导入 / 查询 / 检查 / 删除');

  const add = asset.command('add').description('登记资产');
  add
    .requiredOption('--name <name>', '资产名（全局唯一）')
    .addOption(new Option('--type <type>', '资产类型').choices([...ASSET_TYPES]))
    .option('--addr <addr>', '地址（host 必填；host 或 host:port）')
    .addOption(new Option('--connect-mode <mode>', '连接模式').choices(['local', 'ssh']))
    .option('--label <pair>', '标签 key=value，可重复', collectPair, [])
    .action((options: AddOptions) => {
      const created = addAsset({
        name: options.name,
        type: options.type as AssetType,
        addr: options.addr,
        connectMode: options.connectMode as ConnectMode | undefined,
        labels: parseLabelPairs(options.label),
      });
      process.stdout.write(
        `已登记 ${created.name}（${created.id}，${created.type}${created.addr === undefined ? '' : `，${created.addr}`}）\n`,
      );
    });

  asset
    .command('import <file>')
    .description('从 JSON 数组批量导入（全有或全无）')
    .action((file: string) => {
      process.stdout.write(renderImportSummary(importAssets(file)));
    });

  configureListCommand(asset.command('list').description('资产清单'));

  asset
    .command('show <target>')
    .description('资产详情 + 最近检查历史（target 为 name 或 id）')
    .option('--json', '机器可读输出')
    .action((target: string, options: TargetOptions) => {
      const found = getAsset(target);
      if (options.json === true) {
        printJson({ asset: found, checks: getCheckHistory(found.id, 5) });
        return;
      }
      process.stdout.write(renderAssetDetail(found, getCheckHistory(found.id, 5)));
    });

  asset
    .command('check <target>')
    .description('TCP 连通性检查并记录状态（检查失败记为 down，不算命令错误）')
    .option('--json', '机器可读输出')
    .action(async (target: string, options: TargetOptions) => {
      const result = await checkAsset(target);
      if (options.json === true) printJson(result);
      else process.stdout.write(renderCheckResult(result));
    });

  asset
    .command('remove <target>')
    .description('删除资产（检查历史一并清理）')
    .action((target: string) => {
      removeAsset(target);
      process.stdout.write(`已删除 ${target}\n`);
    });

  return asset;
}
