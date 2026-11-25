import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_RETENTION_DAYS,
  archiveSessions,
  listColdArchive,
  planArchive,
  restoreSession,
  type DshPaths,
} from '../src/dsh/archive.js';
import { dshAdapter } from '../src/parsers/dsh.js';
import { listRecentSessions, resolveSession } from '../src/resolver.js';
import { readTurns } from '../src/reader.js';
import { searchSessions } from '../src/search.js';
import { indexSession } from '../src/store/indexer.js';
import { openStore, resetStoreCache } from '../src/store/db.js';
import { apply } from '../src/dsh/plugin.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PINNED = '33333333-3333-4333-8333-333333333333';
const LOCKED = '44444444-4444-4444-8444-444444444444';
const RECENT = '55555555-5555-4555-8555-555555555555';
const LIVE = '66666666-6666-4666-8666-666666666666';

interface Fixture {
  paths: DshPaths;
  writeWorkspace(archived: string[], pinned?: string[]): Promise<void>;
  makeSession(id: string, options?: { workspaceDir?: string; daysOld?: number; lock?: 'stale' | 'active' | 'pid'; title?: string }): Promise<string>;
  workspace(): Promise<any>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), '1session-cold-archive-'));
  const paths: DshPaths = {
    home,
    sessionsDir: path.join(home, '.dsh', 'sessions'),
    archiveDir: path.join(home, '.dsh', 'sessions-archive'),
    workspaceFile: path.join(home, '.dsh', 'storages', 'workspace.json'),
  };
  const keys = ['DSH_HOME', 'DSH_SESSIONS_DIR', 'DSH_SESSIONS_ARCHIVE_DIR', 'DSH_WORKSPACE_STORAGE',
    'SESSION_READER_DB', 'SESSION_READER_COLD_ARCHIVE_ENABLED', 'SESSION_READER_COLD_ARCHIVE_EVENT'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.DSH_HOME = path.join(home, '.dsh');
  for (const key of keys.slice(1, 4)) delete process.env[key];
  process.env.SESSION_READER_DB = path.join(home, 'index.db');
  resetStoreCache();
  t.after(async () => {
    (await openStore()).close();
    resetStoreCache();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const writeWorkspace = async (archived: string[], pinned: string[] = []) => {
    await fs.mkdir(path.dirname(paths.workspaceFile), { recursive: true });
    await fs.writeFile(paths.workspaceFile, JSON.stringify({
      unit: { name: 'dsh', version: 3 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: archived, pinnedSessionIds: pinned },
      tables: { workspaces: {} },
    }, null, 2));
  };

  const makeSession: Fixture['makeSession'] = async (id, options = {}) => {
    const workspaceDir = options.workspaceDir ?? 'project';
    const dir = path.join(paths.sessionsDir, workspaceDir, `session-${id}`);
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      { type: 'session', version: 4, id: `session-${id}`, cwd: path.join(home, 'workspace'), createdAt: 1_700_000_000_000 },
      { type: 'session/title', seq: 1, time: 1_700_000_001_000, data: { title: options.title ?? '冷归档检索关键词' } },
      { type: 'turn/start', seq: 2, time: 1_700_000_002_000, data: { turn: 1 } },
      { type: 'user/message', seq: 3, time: 1_700_000_003_000, data: { id: `u-${id}`, source: { kind: 'user' }, content: [{ type: 'text', text: '冷归档检索关键词' }] } },
      { type: 'assistant/message', seq: 4, time: 1_700_000_004_000, data: { message: { id: `a-${id}`, content: [{ type: 'text', text: '已确认原文可读' }] } } },
    ];
    const transcript = path.join(dir, 'session.v4.jsonl.zstd');
    await fs.writeFile(transcript, Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`)))));
    const daysOld = options.daysOld ?? 60;
    const stamp = new Date(Date.now() - daysOld * 86_400_000);
    await fs.utimes(dir, stamp, stamp);
    await fs.utimes(transcript, stamp, stamp);
    if (options.lock) {
      const lock = path.join(dir, 'session.lock');
      await fs.writeFile(lock, options.lock === 'pid' ? String(process.pid) : '');
      if (options.lock !== 'active') await fs.utimes(lock, stamp, stamp);
    }
    return transcript;
  };

  return {
    paths, writeWorkspace, makeSession,
    workspace: async () => JSON.parse(await fs.readFile(paths.workspaceFile, 'utf8')),
  };
}

test('planArchive is read-only and skips pinned, actively locked, recent, and non-archived sessions', async (t) => {
  const f = await fixture(t);
  await f.writeWorkspace([A, PINNED, LOCKED, RECENT], [PINNED]);
  await f.makeSession(A, { daysOld: 60, lock: 'stale' });
  await f.makeSession(PINNED, { workspaceDir: 'other', daysOld: 60 });
  await f.makeSession(LOCKED, { daysOld: 60, lock: 'active' });
  await f.makeSession(RECENT, { daysOld: 1 });
  await f.makeSession(LIVE, { daysOld: 60 });

  const plan = await planArchive({ days: 30 });
  assert.deepEqual(plan.eligible.map((item) => item.sessionId), [A]);
  assert.deepEqual(Object.fromEntries(plan.skipped.map((item) => [item.sessionId, item.reason])), {
    [PINNED]: 'pinned session', [LOCKED]: 'active session.lock', [RECENT]: 'newer than retention window',
  });
  await assert.rejects(fs.stat(f.paths.archiveDir), { code: 'ENOENT' });
  assert.deepEqual((await f.workspace()).global.archivedSessionIds, [A, PINNED, LOCKED, RECENT]);

  const immediate = await planArchive({ sessionId: RECENT });
  assert.deepEqual(immediate.eligible.map((item) => item.sessionId), [RECENT]);
  assert.ok(immediate.bytes > 0);
  await assert.rejects(planArchive({ sessionId: LIVE }), /not archived in DSH/);
  await f.writeWorkspace([A, PINNED, LOCKED, RECENT, B], [PINNED]);
  await assert.rejects(planArchive({ sessionId: B }), /directory not found/);
});

test('default retention is 7 days, with only archived and unpinned sessions eligible', async (t) => {
  const f = await fixture(t);
  assert.equal(DEFAULT_RETENTION_DAYS, 7);
  await f.writeWorkspace([A, PINNED], [PINNED]);
  await f.makeSession(A, { daysOld: 10 });
  await f.makeSession(PINNED, { daysOld: 10, workspaceDir: 'pinned-project' });
  const plan = await planArchive();
  assert.deepEqual(plan.eligible.map((item) => item.sessionId), [A]);
  assert.deepEqual(plan.skipped.map((item) => [item.sessionId, item.reason]), [[PINNED, 'pinned session']]);
});

test('archiveSessions moves losslessly, writes an indexed metadata record and a workspace backup; restore reverses it', async (t) => {
  const f = await fixture(t);
  await f.writeWorkspace([A, B]);
  const first = await f.makeSession(A, { workspaceDir: 'project-one', daysOld: 60 });
  const second = await f.makeSession(B, { workspaceDir: 'project-two', daysOld: 45 });
  const originalFirst = await fs.readFile(first);
  const originalSecond = await fs.readFile(second);

  const result = await archiveSessions({ days: 30 });
  assert.equal(result.moved.length, 2);
  assert.equal(result.freedBytes, result.bytes);
  assert.equal(result.indexUpdated, true);
  assert.ok(result.backupPath?.includes('.cold-archive-backup-'));
  const backup = JSON.parse(await fs.readFile(result.backupPath!, 'utf8'));
  assert.deepEqual(backup.global.archivedSessionIds, [A, B]);
  assert.deepEqual((await f.workspace()).global.archivedSessionIds, []);
  const entries = await listColdArchive();
  assert.deepEqual(entries.map((entry) => entry.sessionId).sort(), [A, B].sort());
  assert.equal(entries.find((entry) => entry.sessionId === A)!.workspaceDir, 'project-one');
  for (const [entry, original] of [[entries.find((entry) => entry.sessionId === A)!, originalFirst], [entries.find((entry) => entry.sessionId === B)!, originalSecond]] as const) {
    assert.equal(await fs.stat(entry.archivePath).then((stat) => stat.isDirectory()), true);
    assert.deepEqual(await fs.readFile(path.join(entry.archivePath, 'session.v4.jsonl.zstd')), original);
    await assert.rejects(fs.stat(entry.originalPath), { code: 'ENOENT' });
  }

  const restore = await restoreSession({ sessionId: A });
  assert.equal(restore.restored, true);
  assert.ok(restore.backupPath?.includes('.restore-backup-'));
  assert.deepEqual(await fs.readFile(path.join(restore.to, 'session.v4.jsonl.zstd')), originalFirst);
  assert.equal((await listColdArchive()).length, 1);
  assert.deepEqual((await f.workspace()).global.archivedSessionIds, [], 'restored session becomes visible to DSH');
  await assert.rejects(restoreSession({ sessionId: A }), /not found/);
  assert.equal((await archiveSessions({ days: 30 })).moved.length, 0, 'restored session is not re-archived while not DSH-archived');
});

test('archive never overwrites an existing cold target', async (t) => {
  const f = await fixture(t);
  await f.writeWorkspace([A]);
  await f.makeSession(A, { daysOld: 60 });
  const target = path.join(f.paths.archiveDir, 'project', `session-${A}`);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'keep.txt'), 'existing');

  const plan = await planArchive({ days: 30 });
  assert.equal(plan.items[0]!.status, 'conflict');
  const result = await archiveSessions({ days: 30 });
  assert.equal(result.moved.length, 0);
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'existing');
  assert.equal(await fs.stat(path.join(f.paths.sessionsDir, 'project', `session-${A}`)).then((s) => s.isDirectory()), true);
  assert.deepEqual((await f.workspace()).global.archivedSessionIds, [A]);
});

test('cold archive sessions remain discoverable, searchable, readable and filterable', async (t) => {
  const f = await fixture(t);
  await f.writeWorkspace([A]);
  const candidate = { ...(await (async () => {
    await f.makeSession(A, { daysOld: 60 });
    await archiveSessions({ days: 30 });
    return (await dshAdapter.listCandidates()).find((item) => item.id === A)!;
  })()) };

  assert.equal(candidate.coldArchived, true);
  const cold = await listRecentSessions({ provider: 'dsh', archive: 'cold', useIndex: false });
  const hot = await listRecentSessions({ provider: 'dsh', archive: 'hot', useIndex: false });
  assert.deepEqual(cold.map((ref) => ref.id), [A]);
  assert.equal(cold[0]!.coldArchived, true);
  assert.equal(hot.length, 0);
  assert.equal((await listRecentSessions({ provider: 'dsh', useIndex: false })).length, 1);

  const resolved = await resolveSession(A);
  assert.equal(resolved?.ref.coldArchived, true);
  const page = await readTurns(A, '1', { useIndex: false });
  assert.equal(page.items[0]!.content, '冷归档检索关键词');
  assert.equal((await searchSessions('冷归档检索关键词', { provider: 'dsh', useIndex: false }))[0]!.session.coldArchived, true);

  await indexSession(await openStore(), { adapter: dshAdapter, candidate });
  const indexed = await listRecentSessions({ provider: 'dsh', archive: 'cold', refresh: false });
  assert.equal(indexed[0]!.coldArchived, true, 'index-backed listings also mark cold sessions');

  // Both the index-backed and direct search paths must find the cold transcript.
  for (const useIndex of [true, false]) {
    const hits = await searchSessions('冷归档检索关键词', { provider: 'dsh', useIndex });
    assert.deepEqual(hits.map((hit) => hit.session.id), [A]);
    assert.equal(hits[0]!.session.coldArchived, true);
    assert.equal((await searchSessions('冷归档检索关键词', { provider: 'dsh', useIndex, archive: 'cold' })).length, 1);
    assert.equal((await searchSessions('冷归档检索关键词', { provider: 'dsh', useIndex, archive: 'hot' })).length, 0);
  }

  const cli = await promisify(execFile)(process.execPath, [
    '--import', 'tsx', path.resolve('bin/1session.ts'),
    'search', '冷归档检索关键词', '--provider', 'dsh', '--global', '--json',
  ], { env: { ...process.env, SESSION_READER_CALLER_SESSION: '' } });
  const cliHits = JSON.parse(cli.stdout);
  assert.deepEqual(cliHits.map((hit: any) => hit.session.id), [A]);
  assert.equal(cliHits[0]!.session.coldArchived, true);
});

test('DSH plugin is read-only for archiving: no auto listener or run endpoint, but browse and restore work', async (t) => {
  const f = await fixture(t);
  await f.writeWorkspace([A, B]);
  await f.makeSession(A, { daysOld: 60 });
  await f.makeSession(B, { workspaceDir: 'event-workspace', daysOld: 60 });

  const tools = new Map<string, any>();
  const effects: (() => void)[] = [];
  const events = new Map<string, (payload: any) => void>();
  let route: any;
  apply({
    effect: (setup: any) => { const disposal = setup(); if (typeof disposal === 'function') effects.push(disposal); },
    on: (event: string, listener: (payload: any) => void) => { events.set(event, listener); return () => events.delete(event); },
    tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    webServer: { register: (value: any) => { route = value; return () => {}; } },
  });
  t.after(() => effects.forEach((dispose) => dispose()));
  assert.deepEqual([...tools.keys()].filter((name) => name.startsWith('cold_archive_')),
    ['cold_archive_list', 'cold_archive_restore']);
  assert.deepEqual(tools.get('cold_archive_restore').parameters.required, ['sessionId']);
  assert.equal(events.size, 0, 'the plugin must not listen to DSH archive events');

  // Simulate the CLI: the library performs the physical move; the plugin never does.
  const run = await archiveSessions({ days: 30 });
  assert.equal(run.moved.length, 2);
  assert.equal((await tools.get('cold_archive_list').execute()).count, 2);

  const request = (url: string, method: string, body?: unknown, origin?: string) => Object.assign(
    Readable.from([body === undefined ? '' : JSON.stringify(body)]),
    { url, method, headers: { host: 'localhost', ...(origin ? { origin } : {}) } },
  );
  const response = () => ({ statusCode: 200, body: '', setHeader() {}, end(value: string) { this.body = value; } });
  const listRes: any = response();
  await route.handler(request('/api/session-reader/cold-archive/list', 'GET'), listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(JSON.parse(listRes.body).count, 2);

  const archiveRes: any = response();
  await route.handler(request('/api/session-reader/cold-archive/archive', 'POST', { sessionId: A }, 'http://localhost'), archiveRes);
  assert.equal(archiveRes.statusCode, 404, 'cold archive execution is CLI-only');

  const blocked: any = response();
  await route.handler(request('/api/session-reader/cold-archive/restore', 'POST', { sessionId: A }, 'http://elsewhere'), blocked);
  assert.equal(blocked.statusCode, 403);

  const restored: any = response();
  await route.handler(request('/api/session-reader/cold-archive/restore', 'POST', { sessionId: A }, 'http://localhost'), restored);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(JSON.parse(restored.body).restored, true);
});
