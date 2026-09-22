#!/usr/bin/env node
/**
 * 模块阅读包（借鉴 ZCode architecture:context 的轻量版）：
 * 输入一个模块路径（文件或目录），输出——文件清单与行数、内部依赖（它引了谁）、
 * 反向依赖（谁引了它）、该模块内的架构违规。改不熟悉的模块前先跑它。
 * 用法：pnpm arch:context src/services | pnpm arch:context src/services/actions.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const targetArg = process.argv[2];
if (targetArg === undefined) {
  console.error('用法: pnpm arch:context <src 下的文件或目录>');
  process.exit(2);
}
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SRC = join(ROOT, 'src');
const TARGET = resolve(ROOT, targetArg);
const REL = relative(ROOT, TARGET);
if (!REL.startsWith('src') || REL.startsWith('..')) {
  console.error(`目标需在 src/ 下：${REL}`);
  process.exit(2);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

const allFiles = walk(SRC);
const targetFiles = statSync(TARGET).isDirectory()
  ? allFiles.filter((f) => f.startsWith(TARGET + sep))
  : (statSync(TARGET).isFile() ? [TARGET] : []);

if (targetFiles.length === 0) {
  console.error(`目标下没有 .ts 文件：${REL}`);
  process.exit(2);
}

const importsOf = new Map(); // file -> Set<internal spec>
for (const file of allFiles) {
  const text = readFileSync(file, 'utf8');
  const specs = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/from\s+['"](\.[^'"]+)['"]/);
    if (m) specs.add(m[1]);
  }
  importsOf.set(file, specs);
}

/** 把相对 import 解析为绝对文件路径（容错 .js 后缀与省略扩展名） */
function resolveSpec(fromFile, spec) {
  const base = resolve(fromFile, '..', spec.replace(/\.js$/, ''));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (allFiles.includes(candidate)) return candidate;
  }
  return undefined;
}

console.log(`╔═ 模块阅读包：${REL}`);
console.log(`╚═ 文件 ${targetFiles.length} 个，共 ${targetFiles.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0)} 行\n`);

console.log('── 文件清单（行数 / 被引用次数）');
for (const file of targetFiles) {
  const rel = relative(ROOT, file);
  const loc = readFileSync(file, 'utf8').split('\n').length;
  const refCount = allFiles.filter(
    (other) => other !== file && [...(importsOf.get(other) ?? [])].some((s) => resolveSpec(other, s) === file),
  ).length;
  console.log(`  ${String(loc).padStart(4)} 行  被 ${refCount} 处引用  ${rel}`);
}

console.log('\n── 内部依赖（它引了谁）');
const seen = new Set();
for (const file of targetFiles) {
  for (const spec of importsOf.get(file) ?? []) {
    const resolved = resolveSpec(file, spec);
    if (resolved === undefined || targetFiles.includes(resolved)) continue;
    const key = relative(ROOT, resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  → ${key}`);
  }
}

console.log('\n── 反向依赖（谁引了它）');
for (const file of targetFiles) {
  const rel = relative(ROOT, file);
  const importers = allFiles
    .filter((other) => !targetFiles.includes(other))
    .filter((other) => [...(importsOf.get(other) ?? [])].some((s) => resolveSpec(other, s) === file));
  for (const importer of importers) console.log(`  ← ${relative(ROOT, importer)} 引用 ${rel}`);
}

console.log('\n── 架构违规（同 arch:check 规则，仅本模块）');
// 复用 check-architecture 的规则实现（进程内 import 会重复执行扫描，这里做轻量内联）
const FORBIDDEN = new Set(['node:child_process', 'node:fs', 'node:fs/promises', 'node:net', 'node:http', 'node:https']);
let found = 0;
const isServices = targetFiles.some((f) => relative(ROOT, f).startsWith(join('src', 'services')));
for (const file of targetFiles) {
  const rel = relative(ROOT, file);
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const m = line.match(/from\s+['"]([^'"]+)['"]/);
    if (m && isServices && FORBIDDEN.has(m[1])) {
      console.log(`  ✗ ${rel}:${i + 1} services 禁止 import ${m[1]}`);
      found += 1;
    }
    if (/\bprocess\.env\b/.test(line) && !rel.startsWith(join('src', 'config'))) {
      console.log(`  ✗ ${rel}:${i + 1} process.env 直读`);
      found += 1;
    }
    if (/\bprocess\.exit\b/.test(line) && rel !== join('src', 'cli', 'index.ts')) {
      console.log(`  ✗ ${rel}:${i + 1} process.exit 越界`);
      found += 1;
    }
  });
}
if (found === 0) console.log('  （无违规）');
