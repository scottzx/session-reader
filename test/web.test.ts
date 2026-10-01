import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { renderIndexHtml, serveWeb } from '../src/web/server.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adapters } from '../src/resolver.js';
import { claudeAdapter } from '../src/parsers/claude.js';
import { listSessionsForUi } from '../src/web/api.js';
import { agentReference, sessionKey } from '../src/web/references.js';
import { selectedWorkspace } from '../src/dsh/workspace.js';
import { resetStoreCache, openStore } from '../src/store/db.js';

test('DSH workspace follows the selected session and its latest cwd, not catalog order', () => {
  const items = [
    { path: '/first', workspaceId: 'first', sessionIds: ['one'] },
    { path: '/selected', title: 'Selected', workspaceId: 'selected', sessionIds: ['two'] },
  ];
  assert.deepEqual(selectedWorkspace('two', { two: { cwd: '/selected' } }, items), {
    cwd: '/selected', title: 'Selected', workspaceId: 'selected',
  });
  assert.equal(selectedWorkspace('two', { two: { cwd: '/changed' } }, items).cwd, '/changed');
  assert.equal(selectedWorkspace('two', {}, items).cwd, '/selected');
  assert.deepEqual(selectedWorkspace(undefined, {}, items), {});
  assert.deepEqual(selectedWorkspace('unknown', {}, items), {});
});

test('agent references retain provider, exact message locator, and safe CLI quoting', () => {
  const ref = { id: 'native-session', provider: 'claude' as const, path: '/tmp/session.jsonl', title: '检索讨论' };
  assert.equal(sessionKey(ref), 'claude:native-session');
  assert.equal(sessionKey({ ...ref, id: 'claude:native-session' }), 'claude:native-session');
  const locator = 'event:record-123:block-2';
  const text = agentReference(ref, { locator, excerpt: '第一行\n\n```ts\nconst x = 1;\n```' });
  assert.ok(text.includes('消息定位：' + locator));
  assert.ok(text.includes("1session turn 'claude:native-session' --locator '" + locator + "' --json"));
  assert.ok(text.includes('第一行\n\n```ts\nconst x = 1;\n```'));
  assert.ok(!text.includes('--event'), 'transient event numbers are not portable references');
  const artifact = agentReference(ref, { artifactPath: "/tmp/Scott's plan.md" });
  assert.ok(artifact.includes("--artifact '/tmp/Scott'\\''s plan.md'"));
  assert.ok(agentReference(ref).includes("1session turns 'claude:native-session' --json"));
  const call = agentReference(ref, { locator, callId: 'native-call' });
  assert.ok(call.includes("--call 'native-call'"), 'tool references read both parameters and results');
});

test('UI listing reaches older sessions beyond the previous scan ceiling without parsing transcripts', async () => {
  const saved = adapters.map((adapter) => adapter.listCandidates);
  const scanRef = claudeAdapter.scanRef;
  const parse = claudeAdapter.parse;
  try {
    adapters.forEach((adapter) => { adapter.listCandidates = async () => []; });
    claudeAdapter.listCandidates = async () => Array.from({ length: 230 }, (_, i) => ({
      id: 'session-' + i, path: '/tmp/ui/' + i, mtimeMs: 2_000_000 - i, sizeBytes: 10,
    }));
    claudeAdapter.scanRef = async (candidate) => ({ id: candidate.id, path: candidate.path, provider: 'claude', updatedAt: new Date(candidate.mtimeMs).toISOString() });
    claudeAdapter.parse = async () => { throw new Error('list must remain metadata only'); };
    const page = await listSessionsForUi({ limit: 20, offset: 205 });
    assert.equal(page.length, 20);
    assert.equal(page[0]!.id, 'session-205');
    assert.equal(page.at(-1)!.id, 'session-224');
    await assert.rejects(listSessionsForUi({ offset: -1 }), /offset/);
  } finally {
    adapters.forEach((adapter, i) => { adapter.listCandidates = saved[i]!; });
    claudeAdapter.scanRef = scanRef;
    claudeAdapter.parse = parse;
  }
});

test('reader API pages session metadata, supplies a turn directory, and resolves copied message references', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-reader-ui-'));
  const previousDb = process.env.SESSION_READER_DB;
  const saved = adapters.map((adapter) => adapter.listCandidates);
  process.env.SESSION_READER_DB = path.join(dir, 'index.db');
  resetStoreCache();
  adapters.forEach((adapter) => { adapter.listCandidates = async () => []; });
  let server: Awaited<ReturnType<typeof serveWeb>> | undefined;
  try {
    const now = new Date().toISOString();
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: now, cwd: '/tmp/ui-project', message: { role: 'user', content: '讨论分页' } },
      { type: 'assistant', uuid: 'a1', timestamp: now, message: { content: [{ type: 'text', text: '第一轮原文\n保留换行' }] } },
      { type: 'user', uuid: 'u2', timestamp: now, cwd: '/tmp/ui-project', message: { role: 'user', content: '确认关键对话' } },
      { type: 'assistant', uuid: 'a2', timestamp: now, message: { content: [{ type: 'text', text: '准确定位这一段' }] } },
    ];
    const projectDir = path.join(dir, '-tmp-ui-project');
    await fs.mkdir(projectDir);
    const file = path.join(projectDir, 'ui-session.jsonl');
    await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const stat = await fs.stat(file);
    claudeAdapter.listCandidates = async () => ['ui-session-one', 'ui-session-two'].map((id) => ({ id, path: file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size }));
    server = await serveWeb({ port: 0, cwd: '/tmp/ui-project' });
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/session-reader';
    const first = await (await fetch(base + '/sessions?limit=1')).json() as any;
    assert.equal(first.sessions.length, 1);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 1);
    const second = await (await fetch(base + '/sessions?limit=1&offset=1')).json() as any;
    assert.notEqual(first.sessions[0].id, second.sessions[0].id);
    assert.equal(second.hasMore, false);
    assert.equal((await fetch(base + '/sessions?offset=-1')).status, 400);
    const id = sessionKey(first.sessions[0]);
    const directory = await (await fetch(base + '/session/' + encodeURIComponent(id) + '/directory')).json() as any;
    assert.equal(directory.turns.length, 2);
    assert.equal(directory.turns[1].no, 2);
    assert.equal(directory.turns[0].items, undefined, 'directory does not hydrate message bodies');
    const details = await (await fetch(base + '/session/' + encodeURIComponent(id) + '/details')).json() as any;
    assert.ok(details.overview);
    assert.equal(details.turns, undefined, 'auxiliary details do not download the whole dialogue');
    const content = await (await fetch(base + '/session/' + encodeURIComponent(id) + '/content?turns=2')).json() as any;
    assert.ok(content.items.some((item: any) => item.content === '准确定位这一段'));
    assert.ok(!content.items.some((item: any) => item.content.includes('第一轮原文')));
    const reply = content.items.find((item: any) => item.kind === 'assistant');
    const copied = agentReference(directory.session, { locator: reply.locator, excerpt: reply.content });
    assert.ok(copied.includes(reply.locator));
    const located = await (await fetch(base + '/session/' + encodeURIComponent(id) + '/content?' + new URLSearchParams({ event: reply.locator }))).json() as any;
    assert.equal(located.items[0].content, reply.content);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    (await openStore()).close();
    resetStoreCache();
    adapters.forEach((adapter, i) => { adapter.listCandidates = saved[i]!; });
    if (previousDb === undefined) delete process.env.SESSION_READER_DB; else process.env.SESSION_READER_DB = previousDb;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

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
