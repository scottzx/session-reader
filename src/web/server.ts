/**
 * `1session web` — a standalone browser for the same session list, chat
 * preview and file ledger the DSH plugin shows. Loopback by default; no
 * DreamMate / DSH runtime required.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleSessionApi } from './api.js';

export const DEFAULT_WEB_PORT = 7780;

export interface WebOptions {
  port?: number;
  host?: string;
  /** Workspace the UI treats as "当前工作区". Defaults to process.cwd(). */
  cwd?: string;
  /** Initial scope dropdown: cwd (default) or global. */
  defaultScope?: 'cwd' | 'global';
  /** Open the page in the default browser after listen. */
  open?: boolean;
}

export interface SrUiBoot {
  mode: 'standalone';
  cwd: string;
  title: string;
  defaultScope: 'cwd' | 'global';
}

function appJsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(here, 'app.js');
  // tsx from src/web → repo dist/src/web/app.js; compiled run → sibling.
  const fromSrc = path.resolve(here, '../../dist/src/web/app.js');
  if (fs.existsSync(fromSrc)) return fromSrc;
  return sibling;
}

export function renderIndexHtml(boot: SrUiBoot): string {
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>历史会话 · 1session</title>
  <script>window.__SR_UI__=${bootJson};</script>
  <script src="/app.js" defer></script>
</head>
<body></body>
</html>
`;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

export async function serveWeb(options: WebOptions = {}): Promise<http.Server> {
  const host = options.host ?? '127.0.0.1';
  const cwd = options.cwd ?? process.cwd();
  const defaultScope = options.defaultScope ?? 'cwd';
  const boot: SrUiBoot = {
    mode: 'standalone',
    cwd,
    title: path.basename(cwd) || '当前工作区',
    defaultScope,
  };
  const appJs = appJsPath();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (pathname === '/' || pathname === '/index.html') {
        const body = renderIndexHtml(boot);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
        return;
      }

      if (pathname === '/app.js') {
        if (!fs.existsSync(appJs)) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('missing dist/src/web/app.js — run npm run build');
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(fs.readFileSync(appJs));
        return;
      }

      if (pathname.startsWith('/api/session-reader')) {
        const apiPath = pathname.replace(/^\/api\/session-reader/, '') || '/';
        const handled = await handleSessionApi(apiPath, url, res, { fallbackCwd: cwd });
        if (handled) return;
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: message }));
    }
  });

  const wanted = options.port ?? DEFAULT_WEB_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `端口 ${wanted} 已被占用。换一个：1session web --port <n>；或先停掉占用它的进程：` +
                `lsof -nP -iTCP:${wanted} -sTCP:LISTEN`,
            )
          : error,
      );
    });
    server.listen(wanted, host, resolve);
  });

  const { port } = server.address() as AddressInfo;
  const origin = `http://${host}:${port}`;
  console.log('1session web — 独立历史会话浏览器');
  console.log(`  ${origin}`);
  console.log(`  工作区 ${cwd}`);
  console.log('  列表只拉元数据，点击会话后再加载对话与文件。Ctrl+C 退出。');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.warn(`  ⚠️  绑定在 ${host}：会话原文（代码、shell 历史、密钥）将对该网络开放。`);
  }
  if (options.open) openBrowser(origin);
  return server;
}
