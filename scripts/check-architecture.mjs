#!/usr/bin/env node
/**
 * 架构门禁（AGENTS.md §4 的机器强制）：
 * - services/：禁止直接使用文件/进程/网络 I/O 与环境变量（必须走 adapters/executor/config）
 * - adapters/：禁止反向依赖 services
 * - executor/：禁止依赖 services
 * - process.exit：仅允许 src/cli/index.ts
 * - process.env 直读：仅允许 src/config/（测试文件豁免——测试可以直接摆弄环境）
 * 退出码：0 无违规；1 有违规（清单见输出）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SRC = join(ROOT, 'src');

const FORBIDDEN_NODE_MODULES = new Set([
  'node:child_process',
  'node:fs',
  'node:fs/promises',
  'node:net',
  'node:http',
  'node:https',
  'node:dns',
  'node:dgram',
  'node:cluster',
  'node:worker_threads',
]);

const violations = [];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

const allFiles = walk(SRC).map((f) => ({ abs: f, rel: relative(ROOT, f) }));
const impl = allFiles.filter((f) => !f.rel.endsWith('.test.ts'));

function isUnder(rel, dir) {
  return rel === `src${sep}${dir}` || rel.startsWith(`src${sep}${dir}${sep}`);
}

for (const file of impl) {
  const text = readFileSync(file.abs, 'utf8');
  const lines = text.split('\n');

  // import 来源检查（含 import type / 动态 import / require）
  lines.forEach((line, i) => {
    const match = line.match(/from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]/);
    const spec = match?.[1] ?? match?.[2] ?? match?.[3];
    if (spec === undefined) return;
    if (isUnder(file.rel, 'services') && FORBIDDEN_NODE_MODULES.has(spec)) {
      violations.push(`${file.rel}:${i + 1} services 禁止直接 import ${spec}（走 adapters/executor）`);
    }
    if (isUnder(file.rel, 'adapters') && spec.includes('/services')) {
      violations.push(`${file.rel}:${i + 1} adapters 禁止反向依赖 services`);
    }
    if (isUnder(file.rel, 'executor') && spec.includes('../services')) {
      violations.push(`${file.rel}:${i + 1} executor 禁止依赖 services`);
    }
    if (isUnder(file.rel, 'services') && /(\.\.\/|\.\.\/\.\.\/)+(cli)/.test(spec)) {
      violations.push(`${file.rel}:${i + 1} services 禁止依赖 cli 层`);
    }
  });

  // 代码级检查：process.exit / process.env / fetch(（注释行豁免——文档里出现这些词不是违规）
  lines.forEach((line, i) => {
    if (/^\s*(\*|\/\/|\/*)/.test(line)) return;
    const n = `${file.rel}:${i + 1}`;
    if (/\bprocess\.exit\b/.test(line) && file.rel !== join('src', 'cli', 'index.ts')) {
      violations.push(`${n} process.exit 仅允许出现在 src/cli/index.ts`);
    }
    if (/\bprocess\.env\b/.test(line) && !isUnder(file.rel, 'config')) {
      violations.push(`${n} process.env 直读仅允许 src/config/（测试豁免）`);
    }
    if (/\bfetch\s*\(/.test(line) && isUnder(file.rel, 'services')) {
      violations.push(`${n} services 禁止直接 fetch（走 http 适配器）`);
    }
  });
}

if (violations.length > 0) {
  console.error(`架构违规 ${violations.length} 处：`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log(`架构检查通过（扫描 ${impl.length} 个实现文件）`);
