import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { renderIndexHtml, serveWeb } from '../src/web/server.js';

test('renderIndexHtml injects standalone boot config', () => {
  const html = renderIndexHtml({
    mode: 'standalone',
    cwd: '/tmp/demo',
    title: 'demo',
    defaultScope: 'cwd',
  });
  assert.match(html, /window\.__SR_UI__/);
  assert.match(html, /"mode":"standalone"/);
  assert.match(html, /src="\/app\.js"/);
});

test('1session web serves the panel HTML, lazy session list, and click-to-load files', async () => {
  const server = await serveWeb({ port: 0, host: '127.0.0.1', cwd: process.cwd() });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /历史会话 · 1session/);
    assert.match(html, /"mode":"standalone"/);

    const listRes = await fetch(`${base}/api/session-reader/sessions?limit=3&scope=global`);
    assert.equal(listRes.status, 200, await listRes.clone().text());
    const listBody = (await listRes.json()) as { sessions: Array<{ id: string; turns?: unknown }> };
    assert.ok(Array.isArray(listBody.sessions));
    for (const session of listBody.sessions) {
      assert.ok(session.id);
      assert.equal(session.turns, undefined);
    }

    const target = listBody.sessions[0];
    if (!target) return;

    const detailRes = await fetch(`${base}/api/session-reader/session/${encodeURIComponent(target.id)}`);
    assert.equal(detailRes.status, 200, await detailRes.clone().text());
    const detail = (await detailRes.json()) as { ref?: unknown; turns?: unknown[]; files?: unknown[]; dshEvents?: unknown };
    assert.ok(detail.ref);
    assert.ok(Array.isArray(detail.turns));
    assert.ok(Array.isArray(detail.files));
    assert.equal(detail.dshEvents, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
