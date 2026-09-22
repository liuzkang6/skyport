/**
 * watch 前台值守（spec/governance-ux/spec.md）：
 * 轮询 pending，新行动响铃 + 完整决策要素（风险/发起者名字/目标/命令/理由，红队 U1/U2/U3）；
 * 终端环境默认可就地审批（红队 U4），--no-interactive 或非 TTY 退化为纯播报；Ctrl+C 干净退出。
 */
import { Command } from 'commander';
import { isCancel, select } from '@clack/prompts';
import { getConfig } from '../../config/config';
import { approveAction, getActionEvents, rejectAction, type Action } from '../../services/actions';
import { getLastExecution } from '../../services/action-exec';
import { requireHumanActor } from '../../services/agents';
import { pollPending } from '../../services/watch';
import { renderActionDetail, renderActionResult, renderActionLine } from '../render';

interface WatchOptions {
  readonly interval?: string | undefined;
  readonly once?: boolean | undefined;
  readonly interactive?: boolean | undefined;
}

const QUIT_POLL_SLICE_MS = 200;

export function buildWatchCommand(program: Command): void {
  const command = program
    .command('watch')
    .description('前台值守待审批行动（终端内可就地审批；--once 单次巡检；Ctrl+C 退出）');
  command
    .option('--interval <seconds>', '轮询间隔（秒，默认 3）', '3')
    .option('--once', '单次巡检后退出（脚本/定时任务用，不响铃不交互）')
    .option('--no-interactive', '禁用就地审批，只播报（非终端自动禁用）')
    .action(async (options: WatchOptions) => {
      const intervalSeconds = Number(options.interval);
      if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        throw new Error('--interval 需为正数（秒）');
      }
      const interactive = options.interactive !== false && process.stdout.isTTY === true && options.once !== true;
      let stopped = false;
      const stop = (): void => {
        stopped = true;
      };
      process.once('SIGINT', stop);
      process.stdout.write(
        `值守中：每 ${intervalSeconds}s 巡检一次待审批行动（Ctrl+C 退出${interactive ? '；新待办可直接就地审批' : ''}）\n`,
      );
      let seen = new Set<string>();
      try {
        do {
          const diff = pollPending(seen);
          for (const action of diff.fresh) {
            announceFresh(action, options.once !== true);
            if (interactive) await interactiveReview(action);
          }
          for (const item of diff.resolved) {
            process.stdout.write(`  已处理 ${item.id} → ${item.status}\n`);
          }
          seen = new Set(diff.currentPendingIds);
          if (options.once === true) break;
          await sleepInterruptibly(intervalSeconds * 1_000, () => stopped);
        } while (!stopped);
      } finally {
        process.off('SIGINT', stop);
      }
      process.stdout.write('值守结束\n');
    });
}

function announceFresh(action: Action, bell: boolean): void {
  const prefix = bell ? '\x07' : '';
  process.stdout.write(`${prefix}  新待审批 ${renderActionLine(action)}\n`);
}

/** 就地审批：方向键选择；Esc/Ctrl+C 视为跳过（红队 U4） */
async function interactiveReview(action: Action): Promise<void> {
  const actor = requireHumanActor(getConfig().apiKey); // 审批红线：带 key 的环境拒绝就地审批
  const decide = async (withDetail: boolean): Promise<'approve' | 'reject' | 'skip'> => {
    if (withDetail) {
      process.stdout.write(
        renderActionDetail(action, getActionEvents(action.id), getLastExecution(action.id)),
      );
    }
    const choice = await select({
      message: `${action.id} 如何处理？`,
      options: [
        { value: 'approve', label: '批准并立即执行' },
        { value: 'reject', label: '否决' },
        ...(withDetail ? [] : [{ value: 'detail', label: '查看详情' }]),
        { value: 'skip', label: '跳过（保持待审批）' },
      ],
    });
    if (isCancel(choice)) return 'skip';
    if (choice === 'detail') return decide(true);
    return choice as 'approve' | 'reject' | 'skip';
  };
  const decision = await decide(false);
  if (decision === 'approve') {
    process.stdout.write('  执行中（慢命令请等待）…\n');
    const result = await approveAction(action.id, actor);
    process.stdout.write(renderActionResult(result));
  } else if (decision === 'reject') {
    const updated = rejectAction(action.id, actor);
    process.stdout.write(`  已否决 ${updated.id}\n`);
  }
}

/** 分片睡眠：Ctrl+C 后最多 QUIT_POLL_SLICE_MS 内退出循环 */
function sleepInterruptibly(totalMs: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let waited = 0;
    const tick = (): void => {
      if (shouldStop() || waited >= totalMs) {
        resolve();
        return;
      }
      waited += QUIT_POLL_SLICE_MS;
      setTimeout(tick, QUIT_POLL_SLICE_MS);
    };
    tick();
  });
}
