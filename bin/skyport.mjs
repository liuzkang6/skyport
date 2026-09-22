#!/usr/bin/env node
/**
 * skyport CLI 启动器：开发态部署直接经 tsx 运行 TS 入口。
 * 注意：shebang 的 env node 可能取到低版本系统 node——正式部署请用 bin/skyport 包装脚本
 * 显式指定 ≥20 的 node 路径（见 README 部署一节）。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxEntry = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntry = join(projectRoot, 'src', 'cli', 'index.ts');

const result = spawnSync(process.execPath, [tsxEntry, cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
