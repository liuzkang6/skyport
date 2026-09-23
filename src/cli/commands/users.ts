/**
 * user 命令组（spec/webui）：Web 用户管理——admin 的离线引导面。
 * 密码永不上 argv：TTY 交互输入两次；脚本经 SKYPORT_USER_PASSWORD（config 透传）。
 */
import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import { getConfig } from '../../config/config';
import { createError, ERROR_CODES } from '../../errors/errors';
import { createUser, listUsers, removeUser, setUserStatus, USER_ROLES, type UserRole } from '../../services/users';
import { printJson } from '../render';

interface AddUserOptions {
  readonly role?: string | undefined;
  readonly json?: boolean | undefined;
}

/** 取密码：TTY 两次交互确认；非 TTY 从配置（SKYPORT_USER_PASSWORD）取 */
async function resolvePassword(): Promise<string> {
  if (process.stdin.isTTY === true) {
    const first = await p.password({ message: '密码（至少 8 字符，输入不回显）' });
    if (p.isCancel(first)) {
      p.cancel('已取消');
      throw new Error('已取消');
    }
    const second = (await p.password({ message: '再输一次确认' })) as string;
    if (p.isCancel(second)) {
      p.cancel('已取消');
      throw new Error('已取消');
    }
    if (first !== second) {
      throw new Error('两次输入不一致');
    }
    return first;
  }
  const fromEnv = getConfig().userPassword;
  if (fromEnv === undefined || fromEnv === '') {
    // 红队 V8：域码化报错（config 域，exit 3），不再走"未知错误"
    throw createError(ERROR_CODES.CONFIG_INVALID, '非 TTY 环境：请设置 SKYPORT_USER_PASSWORD 提供密码（或在终端交互输入）', { context: {} });
  }
  return fromEnv;
}

export function buildUserCommand(): Command {
  const user = new Command('user').description('Web 用户与角色四分：viewer/operator/approver/admin');

  user
    .command('add <name>')
    .description('创建用户（首个用户建议 --role admin）')
    .addOption(new Option('--role <role>', '角色').choices([...USER_ROLES]).default('viewer'))
    .option('--json', 'JSON 输出')
    .action(async (name: string, options: AddUserOptions) => {
      const password = await resolvePassword();
      const created = createUser(name, password, options.role as UserRole);
      const summary = { id: created.id, name: created.name, role: created.role, status: created.status };
      if (options.json === true) {
        printJson(summary);
      } else {
        process.stdout.write(`用户已创建：${created.name}（${created.role}，${created.id}）\n`);
      }
    });

  user
    .command('list')
    .description('用户清单（不含哈希与盐）')
    .option('--json', 'JSON 输出')
    .action((options: { json?: boolean | undefined }) => {
      const users = listUsers();
      if (options.json === true) {
        printJson({ users, count: users.length });
        return;
      }
      if (users.length === 0) {
        process.stdout.write('暂无用户：先 skyport user add <名> --role admin 创建第一个管理员\n');
        return;
      }
      process.stdout.write('NAME\tROLE\tSTATUS\tCREATED\n');
      for (const u of users) {
        process.stdout.write(`${u.name}\t${u.role}\t${u.status}\t${u.createdAt}\n`);
      }
    });

  user
    .command('disable <target>')
    .description('停用用户（name 或 ID；立即吊销其全部 Web 会话，登录被拒）')
    .action((target: string) => {
      const updated = setUserStatus(target, 'disabled');
      process.stdout.write(`已停用 ${updated.name}（现有会话已全部吊销；user enable 可恢复）\n`);
    });

  user
    .command('enable <target>')
    .description('恢复被停用的用户')
    .action((target: string) => {
      const updated = setUserStatus(target, 'active');
      process.stdout.write(`已恢复 ${updated.name}\n`);
    });

  user
    .command('remove <target>')
    .description('删除用户（name 或 ID；会话一并清除，不可恢复）')
    .action((target: string) => {
      const removed = removeUser(target);
      process.stdout.write(`已删除 ${removed.name}（${removed.id}）\n`);
    });

  return user;
}
