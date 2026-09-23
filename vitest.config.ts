import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * vitest 解析配置：
 * - @zcode/contracts → vendor 垫片（与 tsconfig.paths 同源）
 * - vendor 内部的 `./x.js` ESM 风格导入映射回 `./x.ts`（vite 不做 TS 扩展替换）
 * - 测试范围限定 src/（webui 有独立工程）
 */
export default defineConfig({
  resolve: {
    alias: {
      '@zcode/contracts': fileURLToPath(new URL('./vendor/zcode-runtime/contracts.ts', import.meta.url)),
    },
  },
  plugins: [
    {
      name: 'vendor-ts-extension',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!source.startsWith('.') || !source.endsWith('.js')) return null;
        if (importer === undefined || !importer.includes('/vendor/')) return null;
        const resolved = path.resolve(path.dirname(importer), `${source.slice(0, -3)}.ts`);
        return existsSync(resolved) ? resolved : null;
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
