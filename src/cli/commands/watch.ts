/**
 * watch 前台值守（M3，spec/governance-ux/spec.md）：
 * 轮询 pending 行动，新行动响铃 + 已处理行动播报终态；Ctrl+C 干净退出。
 */
import { Command } from 'commander';
import { pollPending } from '../../services/watch';
import type { Action } from '../../services/actions';

interface WatchOptions {
  readonly interval?: string | undefined;
  readonly once?: boolean | undefined;
}

const QUIT_POLL_SLICE_MS = 200;

export function buildWatchCommand(program: Command): void {
  const command = program
    .command('watch')
    .description('前台值守待审批行动（新行动响铃提醒；--once 单次巡检，Ctrl+C 退出）');
  command
    .option('--interval <seconds>', '轮询间隔（秒，默认 3）', '3')
    .option('--once', '单次巡检后退出（脚本/定时任务用，不响铃）')
    .action(async (options: WatchOptions) => {
      const intervalSeconds = Number(options.interval);
      if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        throw new Error('--interval 需为正数（秒）');
      }
      let stopped = false;
      const stop = (): void => {
        stopped = true;
      };
      process.once('SIGINT', stop);
      process.stdout.write(`值守中：每 ${intervalSeconds}s 巡检一次待审批行动（Ctrl+C 退出）\n`);
      let seen = new Set<string>();
      try {
        do {
          const diff = pollPending(seen);
          for (const action of diff.fresh) {
            announceFresh(action, options.once !== true);
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
  process.stdout.write(
    `${prefix}  新待审批 ${action.id}  [${action.riskLevel}]  ${action.actorType}:${action.actorId}  ${action.command}\n` +
      `    处理：skyport approve ${action.id}  |  skyport reject ${action.id}\n`,
  );
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
