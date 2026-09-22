#!/usr/bin/env node
/**
 * skyport CLI 启动器：开发态部署直接经 tsx 运行 TS 入口。
 * 注意：shebang 的 env node 可能取到低版本系统 node——正式部署请用 bin/skyport 包装脚本
 * 显式指定 ≥20 的 node 路径（见 README 部署一节）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 红队 S1：node < 20 时给中文指引而非裸崩堆栈（本守卫只用 node18 可解析的语法）
// 红队 N1：同样用 exitCode 自然退出，保证提示完整到达管道
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  console.error('[skyport] Node 版本过低（当前 ' + process.version + '），skyport 需要 Node.js >= 20。');
  console.error('           请改用高版本 node 运行，例如：~/node22/bin/node，或先安装 Node 20+。');
  process.exitCode = 2;
} else {
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  // 已构建则优先产物（启动快）；未构建回退 tsx 开发态——与 src/cli 同为两层深度，package.json 解析一致
  const distEntry = join(projectRoot, 'dist', 'cli', 'index.mjs');
  const tsxEntry = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliSource = join(projectRoot, 'src', 'cli', 'index.ts');
  const args = existsSync(distEntry)
    ? [distEntry, ...process.argv.slice(2)]
    : [tsxEntry, cliSource, ...process.argv.slice(2)];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
