/**
 * WebUI 静态托管（spec/webui）：serve 静态目录 webui/dist/，非 /api 路径 SPA fallback index.html。
 * 目录不存在时整体禁用（API-only 行为不变）。路径穿越防护：resolve 后必须仍在 dist 内。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const DIST_DIR = join(process.cwd(), 'webui', 'dist');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 尝试按静态文件应答；命中返回 true（已写响应），未命中返回 false（调用方继续走 API 路由） */
export function serveStatic(res: ServerResponse, pathname: string): boolean {
  if (!existsSync(DIST_DIR)) return false;

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = resolve(DIST_DIR, relative);
  if (candidate !== DIST_DIR && !candidate.startsWith(DIST_DIR + sep)) return false;

  let filePath = candidate;
  let stat = existsSync(filePath) && statSync(filePath).isFile() ? statSync(filePath) : undefined;
  if (stat === undefined) {
    // SPA fallback：非 /api 且非真实文件 → index.html（前端路由接管）
    const indexPath = join(DIST_DIR, 'index.html');
    if (!existsSync(indexPath)) return false;
    filePath = indexPath;
    stat = statSync(indexPath);
  }

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(filePath).pipe(res);
  return true;
}
