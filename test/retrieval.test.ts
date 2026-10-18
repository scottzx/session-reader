import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adapters, listRecentSessions, loadSession, resolveSession } from '../src/resolver.js';
import { listProjects, listProjectWeeks } from '../src/projects.js';
import { claudeAdapter } from '../src/parsers/claude.js';
import { codexAdapter } from '../src/parsers/codex.js';
import { dshAdapter } from '../src/parsers/dsh.js';
import { grokAdapter } from '../src/parsers/grok.js';
import { antigravityAdapter } from '../src/parsers/antigravity.js';
import { searchSessions } from '../src/search.js';
import { readTurnDirectory, readTurns, readEvents, readOriginalRecords, readCall, readArtifact, contentPage } from '../src/reader.js';
import { previewTurns } from '../src/web/api.js';
import { serveWeb } from '../src/web/server.js';
import type { AddressInfo } from 'node:net';
import { openStore, resetStoreCache } from '../src/store/db.js';
import { indexSession } from '../src/store/indexer.js';
import { readSession, sessionRow, findSessionRow } from '../src/store/read.js';
import { selectSession } from '../src/identity.js';
import { callsIn, toolResults } from '../src/calls.js';
import { commandLedger } from '../src/ledger.js';
import type { ProviderAdapter, SessionCandidate } from '../src/parsers/provider.js';
import type { TurnEvent } from '../src/types.js';

async function fixture(run: (dir: string, add: (adapter: ProviderAdapter, name: string, lines: unknown[]) => Promise<SessionCandidate>) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retrieval-'));
  const previous = process.env.SESSION_READER_DB;
  process.env.SESSION_READER_DB = path.join(dir, 'index.db');
  resetStoreCache();
  const saved = adapters.map((adapter) => adapter.listCandidates);
  const candidates = new Map<ProviderAdapter, SessionCandidate[]>();
  adapters.forEach((adapter) => { adapter.listCandidates = async () => candidates.get(adapter) ?? []; });
  const add = async (adapter: ProviderAdapter, name: string, lines: unknown[]) => {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const stat = await fs.stat(file);
    const candidate = { id: name.split('/')[0]!.replace(/\.jsonl$/, ''), path: file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
    candidates.set(adapter, [...(candidates.get(adapter) ?? []), candidate]);
    return candidate;
  };
  try { await run(dir, add); }
  finally {
    const db = await openStore(); db.close(); resetStoreCache();
    adapters.forEach((adapter, i) => { adapter.listCandidates = saved[i]!; });
    if (previous === undefined) delete process.env.SESSION_READER_DB; else process.env.SESSION_READER_DB = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const user = (text: string, uuid: string, timestamp = '2026-01-01T00:00:00Z') => ({ type: 'user', uuid, cwd: '/tmp/ws', timestamp, message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (text: string, uuid: string, timestamp = '2026-01-01T00:00:01Z') => ({ type: 'assistant', uuid, timestamp, message: { id: `message-${uuid}`, content: [{ type: 'text', text }] } });

test('projects merge all five providers by path and use creation time rather than modification time', async () => fixture(async (dir, add) => {
  const workspace = '/tmp/project-list/中文 项目';
  await add(claudeAdapter, 'claude-project.jsonl', [{ ...user('question', 'u1'), cwd: workspace }]);
  await add(codexAdapter, 'codex-project.jsonl', [
    { type: 'session_meta', timestamp: '2026-01-02T00:00:00Z', payload: { cwd: workspace } },
  ]);
  await add(antigravityAdapter, 'antigravity-project/.system_generated/logs/transcript.jsonl', [
    { type: 'GENERIC', created_at: '2026-01-03T00:00:00Z', tool_calls: [{ name: 'run_command', args: { Cwd: workspace } }] },
  ]);
  await add(dshAdapter, 'dsh-project/session.v2.jsonl', [
    { type: 'session', version: 2, cwd: workspace, createdAt: Date.parse('2026-01-04T00:00:00Z') },
  ]);
  await add(grokAdapter, 'grok-project/chat_history.jsonl', [{ type: 'user', content: 'question' }]);
  await fs.writeFile(path.join(dir, 'grok-project/summary.json'), JSON.stringify({
    info: { cwd: workspace }, created_at: '2026-01-05T08:00:00+08:00', updated_at: '2026-12-31T00:00:00Z',
  }));
  await add(claudeAdapter, 'same-name.jsonl', [{ ...user('question', 'u1', '2026-01-06T00:00:00Z'), cwd: '/tmp/other/中文 项目' }]);
  await add(claudeAdapter, 'tied-time.jsonl', [{ ...user('question', 'u1', '2026-01-06T08:00:00+08:00'), cwd: '/tmp/project-list/tie' }]);
  await add(claudeAdapter, 'old-project.jsonl', [
    { ...user('question', 'u1'), cwd: '/tmp/project-list/old' },
    assistant('recent update to old session', 'a1', '2026-12-31T00:00:00Z'),
  ]);
  await add(claudeAdapter, 'undated-project.jsonl', [{ type: 'user', cwd: '/tmp/project-list/undated', message: { content: 'question' } }]);
  await add(claudeAdapter, 'invalid-date.jsonl', [{ ...user('question', 'u1', 'invalid'), cwd: '/tmp/project-list/undated' }]);
  await add(claudeAdapter, 'no-project.jsonl', [{ type: 'user', message: { content: 'question' } }]);

  const indexed = await listProjects();
  const direct = await listProjects({ useIndex: false });
  assert.deepEqual(indexed, direct);
  assert.equal(indexed.total, 5);
  assert.deepEqual(indexed.projects.map((project) => project.workspace), [
    '/tmp/other/中文 项目', '/tmp/project-list/tie', workspace, '/tmp/project-list/old', '/tmp/project-list/undated',
  ]);
  const shared = indexed.projects[2]!;
  assert.equal(shared.name, '中文 项目');
  assert.equal(shared.sessionCount, 5);
  assert.equal(shared.updatedAt, '2026-01-05T00:00:00.000Z');
  assert.deepEqual(shared.providers, ['antigravity', 'claude', 'codex', 'dsh', 'grok']);
  const weekly = await listProjectWeeks({ timeZone: 'UTC' });
  assert.deepEqual(weekly, await listProjectWeeks({ timeZone: 'UTC', useIndex: false }));
  assert.equal(weekly.total, 2, 'late transcript writes must not extend the weekly calendar');
  const sharedWeeks = weekly.weeks.flatMap(week => week.projects.filter(project => project.id === shared.id));
  assert.equal(sharedWeeks.reduce((sum, project) => sum + project.sessionCount, 0), 5);
  assert.deepEqual([...new Set(sharedWeeks.flatMap(project => project.providers))].sort(), shared.providers);
  assert.equal(indexed.projects.at(-1)!.updatedAt, undefined);
  const scoped = await listProjects({ workspace: '/tmp/project-list' });
  assert.equal(scoped.total, 4);
  const filtered = await listProjects({ workspace, provider: 'codex' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.projects[0]!.sessionCount, 1);
  assert.equal(filtered.projects[0]!.updatedAt, '2026-01-02T00:00:00.000Z');
}));

test('projects page after complete discovery, including more than the raw scan budget', async () => fixture(async (_dir, add) => {
  for (let i = 0; i < 65; i++) {
    await add(claudeAdapter, `project-${i}.jsonl`, [{
      ...user('question', 'u1', new Date(Date.UTC(2026, 0, 1 + i)).toISOString()), cwd: `/tmp/projects/project-${i}`,
    }]);
  }
  for (const useIndex of [true, false]) {
    const first = await listProjects({ limit: 30, useIndex });
    assert.equal(first.total, 65);
    assert.equal(first.projects.length, 30);
    assert.equal(first.projects[0]!.name, 'project-64');
    assert.equal(first.nextPage, 2);
    const second = await listProjects({ page: 2, limit: 30, useIndex });
    const last = await listProjects({ page: 3, limit: 30, useIndex });
    assert.equal(second.nextPage, 3);
    assert.equal(last.projects.length, 5);
    assert.equal(last.hasMore, false);
    assert.equal(last.nextPage, undefined);
    assert.equal(new Set([...first.projects, ...second.projects, ...last.projects].map((project) => project.workspace)).size, 65);
    const pastEnd = await listProjects({ page: 4, limit: 30, useIndex });
    assert.deepEqual(pastEnd.projects, []);
    assert.equal(pastEnd.total, 65);
    assert.equal(pastEnd.hasMore, false);
  }
}));

test('Codex project creation time comes from session metadata and refreshes an older index', async () => fixture(async (_dir, add) => {
  const createdAt = '2026-10-03T16:52:02.360Z';
  const recordedAt = '2026-10-03T16:52:02.797Z';
  const candidate = await add(codexAdapter, 'codex-creation-time.jsonl', [
    { type: 'session_meta', timestamp: recordedAt, payload: { cwd: '/tmp/ws', timestamp: createdAt } },
  ]);
  assert.equal((await codexAdapter.scanRef(candidate)).createdAt, createdAt);
  assert.equal((await codexAdapter.parse(candidate)).ref.createdAt, createdAt);
  const db = await openStore();
  const { id } = await indexSession(db, { adapter: codexAdapter, candidate });
  db.prepare('UPDATE sessions SET started_at = ?, parser_version = parser_version - 1 WHERE id = ?').run(recordedAt, id);
  const indexed = await listProjects();
  assert.deepEqual(indexed, await listProjects({ useIndex: false }));
  assert.equal(indexed.projects[0]!.updatedAt, createdAt);
  assert.equal(sessionRow(db, id)!.started_at, createdAt);
}));

test('projects validate pagination and return an empty page for no workspaces', async () => fixture(async () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(listProjects({ page: value }), /page must be a positive safe integer/);
    await assert.rejects(listProjects({ limit: value }), /limit must be a positive safe integer/);
    await assert.rejects(listProjectWeeks({ page: value }), /page must be a positive safe integer/);
    await assert.rejects(listProjectWeeks({ limit: value }), /limit must be a positive safe integer/);
  }
  assert.deepEqual(await listProjects(), { projects: [], total: 0, page: 1, limit: 20, hasMore: false });
  assert.deepEqual(await listProjectWeeks({ timeZone: 'UTC' }), {
    weeks: [], total: 0, page: 1, limit: 20, hasMore: false, timeZone: 'UTC', undatedSessionCount: 0,
  });
  await assert.rejects(listProjectWeeks({ timeZone: 'not/a-zone' }), /time zone/i);
}));

test('projects merge repository subdirectories, clones and worktrees while keeping nested repositories and forks separate', async () => fixture(async (dir, add) => {
  const runGit = (cwd: string, args: string[]) => promisify(execFile)('git', ['-C', cwd, ...args]);
  const main = path.join(dir, 'main'), clone = path.join(dir, 'clone'), fork = path.join(dir, 'fork'), nested = path.join(main, 'nested');
  for (const repo of [main, clone, fork, nested]) { await fs.mkdir(repo, { recursive: true }); await runGit(repo, ['init']); }
  await runGit(main, ['remote', 'add', 'origin', 'https://user:SECRET@github.com/example/shared.git']);
  await runGit(clone, ['remote', 'add', 'origin', 'git@github.com:example/shared.git']);
  await runGit(fork, ['remote', 'add', 'origin', 'https://github.com/someone/shared.git']);
  await runGit(main, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']);
  const worktree = path.join(dir, 'worktree');
  await runGit(main, ['worktree', 'add', '--detach', worktree]);
  for (const [name, cwd] of [['main', main], ['sub', path.join(main, 'src')], ['clone', clone], ['worktree', worktree], ['fork', fork], ['nested', nested]]) {
    await add(claudeAdapter, `repo-${name}.jsonl`, [{ ...user('question', 'u1'), cwd }]);
  }
  await add(codexAdapter, 'repo-codex.jsonl', [{ type: 'session_meta', timestamp: '2026-01-02T00:00:00Z', payload: { cwd: path.join(worktree, 'src') } }]);
  for (const useIndex of [true, false]) {
    const result = await listProjects({ useIndex });
    assert.equal(result.total, 3);
    const shared = result.projects.find(p => p.id === 'git:github.com/example/shared')!;
    assert.equal(shared.sessionCount, 5);
    assert.equal(shared.workspaces.length, 5);
    assert.deepEqual(shared.providers, ['claude', 'codex']);
    assert.equal(shared.mergeSource, 'git');
    assert.equal(shared.createdAt, '2026-01-01T00:00:00.000Z');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.equal(result.projects.find(p => p.workspace === fsSync.realpathSync(nested))!.sessionCount, 1);
  }
}));

test('explicit project maps join historical paths with longest-prefix overrides and validate identities', async () => fixture(async (_dir, add) => {
  for (const cwd of ['/tmp/old-app', '/tmp/new-app', '/tmp/old-app/src', '/tmp/old-app/module', '/tmp/old-app-other']) {
    await add(claudeAdapter, `map-${path.basename(cwd)}.jsonl`, [{ ...user('question', 'u1'), cwd }]);
  }
  const projectMap = [
    { id: 'app', name: '统一项目', workspaces: ['/tmp/new-app', '/tmp/old-app'] },
    { id: 'module', name: '独立模块', workspaces: ['/tmp/old-app/module'] },
  ];
  const indexed = await listProjects({ projectMap });
  assert.deepEqual(indexed, await listProjects({ projectMap, useIndex: false }));
  assert.equal(indexed.total, 3);
  const app = indexed.projects.find(p => p.id === 'mapped:app')!;
  assert.equal(app.name, '统一项目'); assert.equal(app.sessionCount, 3);
  assert.deepEqual(app.workspaces, ['/tmp/new-app', '/tmp/old-app', '/tmp/old-app/src']);
  assert.equal(app.mergeSource, 'mapping');
  for (const invalid of [null, {}, [{ id: 'x', name: 'bad', workspaces: [] }], [...projectMap, projectMap[0]],
    [...projectMap, { id: 'duplicate-path', name: 'bad', workspaces: ['/tmp/old-app'] }]]) {
    await assert.rejects(listProjects({ projectMap: invalid as never }), /project map/);
  }
}));

test('weekly projects use creation time, local Monday boundaries, complete history and empty weeks before pagination', async () => fixture(async (_dir, add) => {
  for (const [name, cwd, at] of [
    ['sunday', '/tmp/old-weekly', '2026-01-04T15:59:59Z'],
    ['monday', '/tmp/new-weekly', '2026-01-04T16:00:00Z'],
    ['another', '/tmp/another-weekly', '2026-01-05T00:00:00Z'],
    ['return', '/tmp/new-weekly', '2026-01-26T00:00:00Z'],
    ['invalid', '/tmp/new-weekly', 'invalid'],
  ]) {
    await add(claudeAdapter, `weekly-${name}.jsonl`, [{ ...user('question', 'u1', at), cwd }, assistant('late update', 'a1', '2026-12-31T00:00:00Z')]);
  }
  await add(codexAdapter, 'weekly-codex.jsonl', [{ type: 'session_meta', timestamp: '2026-02-01T00:00:00Z', payload: { timestamp: '2026-01-04T16:00:00Z', cwd: '/tmp/old-weekly' } }]);
  const options = { timeZone: 'Asia/Shanghai', projectMap: [{ id: 'same', name: '同一项目', workspaces: ['/tmp/old-weekly', '/tmp/new-weekly'] }] };
  const result = await listProjectWeeks(options);
  assert.deepEqual(result, await listProjectWeeks({ ...options, useIndex: false }));
  assert.equal(result.undatedSessionCount, 1);
  assert.equal(result.total, 5);
  assert.deepEqual(result.weeks.map(w => w.week), ['2026-01-26', '2026-01-19', '2026-01-12', '2026-01-05', '2025-12-29']);
  assert.deepEqual(result.weeks.map(w => w.projectCount), [1, 0, 0, 2, 1]);
  assert.deepEqual(result.weeks.map(w => w.newProjectCount), [0, 0, 0, 1, 1]);
  assert.deepEqual(result.weeks.map(w => w.cumulativeProjectCount), [2, 2, 2, 2, 1]);
  assert.deepEqual(result.weeks[3]!.providerSessionCounts, { claude: 2, codex: 1 });
  assert.equal(result.weeks[3]!.projects[0]!.sessionCount, 2);
  assert.equal(result.weeks[3]!.projects[0]!.isNew, false);
  assert.equal(result.weeks[4]!.endDate, '2026-01-04');
  const first = await listProjectWeeks({ ...options, limit: 2 });
  const second = await listProjectWeeks({ ...options, limit: 2, page: 2 });
  const last = await listProjectWeeks({ ...options, limit: 2, page: 3 });
  assert.deepEqual([...first.weeks, ...second.weeks, ...last.weeks], result.weeks);
  assert.equal(first.nextPage, 2); assert.equal(second.nextPage, 3); assert.equal(last.nextPage, undefined);
  assert.deepEqual((await listProjectWeeks({ ...options, page: 4, limit: 2 })).weeks, []);
  const utc = await listProjectWeeks({ ...options, timeZone: 'UTC' });
  assert.equal(utc.weeks.at(-1)!.sessionCount, 3, 'Sunday UTC stays in the previous week');
  const scoped = await listProjectWeeks({ ...options, provider: 'codex', workspace: '/tmp/old-weekly' });
  assert.equal(scoped.total, 1); assert.equal(scoped.weeks[0]!.projects[0]!.isNew, true);
  assert.equal(scoped.weeks[0]!.sessionCount, 1);
}));

test('weekly calendar boundaries follow DST and leap days in the selected IANA zone', async () => fixture(async (_dir, add) => {
  for (const [name, at] of [['leap', '2024-02-29T12:00:00Z'], ['sun', '2024-03-11T03:59:59Z'], ['mon', '2024-03-11T04:00:00Z']]) {
    await add(claudeAdapter, `calendar-${name}.jsonl`, [{ ...user('question', 'u1', at), cwd: '/tmp/calendar' }]);
  }
  const result = await listProjectWeeks({ timeZone: 'America/New_York' });
  assert.deepEqual(result.weeks.map(w => [w.week, w.endDate, w.sessionCount]), [
    ['2024-03-11', '2024-03-17', 1], ['2024-03-04', '2024-03-10', 1], ['2024-02-26', '2024-03-03', 1],
  ]);
}));

test('projects CLI defaults to all projects, supports pages and scope, and validates flags', async () => fixture(async (dir) => {
  const home = path.join(dir, 'home');
  const local = path.join(home, 'work/local');
  const sibling = path.join(home, 'work/sibling');
  await fs.mkdir(local, { recursive: true });
  const sessions = path.join(home, '.claude/projects/test');
  await fs.mkdir(sessions, { recursive: true });
  for (const [name, cwd, timestamp] of [
    ['local', local, '2026-01-01T00:00:00Z'],
    ['sibling', sibling, '2026-01-02T00:00:00Z'],
  ]) {
    await fs.writeFile(path.join(sessions, `${name}.jsonl`), JSON.stringify({ ...user('question', 'u1', timestamp), cwd }) + '\n');
  }
  const args = ['--import', import.meta.resolve('tsx'), path.resolve('bin/1session.ts'), 'projects'];
  const env = { ...process.env, HOME: home, SESSION_READER_NO_INDEX: '0', SESSION_READER_CALLER_SESSION: '' };
  const run = (flags: string[]) => promisify(execFile)(process.execPath, [...args, ...flags], { env, cwd: local });
  const first = JSON.parse((await run(['--limit', '1', '--json'])).stdout);
  assert.equal(first.total, 2);
  assert.equal(first.projects[0].name, 'sibling');
  assert.equal(first.nextPage, 2);
  const second = JSON.parse((await run(['--limit', '1', '--page', '2', '--json', '--no-index'])).stdout);
  assert.equal(second.projects[0].name, 'local');
  assert.equal(second.hasMore, false);
  const scoped = JSON.parse((await run(['--scope', 'cwd', '--json'])).stdout);
  assert.equal(scoped.total, 1);
  assert.equal(scoped.projects[0].name, 'local');
  const text = (await run(['--limit', '1'])).stdout;
  assert.match(text, /最近修改时间（最新会话创建时间）/);
  assert.match(text, /共 2 个项目.*下一页：--page 2/);
  for (const flags of [['--page', 'bad'], ['--limit', '0'], ['--page']]) {
    await assert.rejects(run(flags), /must be a positive safe integer/);
  }
  const mapFile = path.join(dir, 'project-map.json');
  await fs.writeFile(mapFile, JSON.stringify([{ id: 'joined', name: 'Merged project', workspaces: [local, sibling] }]));
  const merged = JSON.parse((await run(['--project-map', mapFile, '--json'])).stdout);
  assert.equal(merged.total, 1); assert.equal(merged.projects[0].sessionCount, 2);
  const weekFlags = ['--weekly', '--timezone', 'Asia/Shanghai', '--project-map', mapFile, '--limit', '1'];
  const weekly = JSON.parse((await run([...weekFlags, '--json'])).stdout);
  assert.equal(weekly.timeZone, 'Asia/Shanghai'); assert.equal(weekly.total, 1);
  assert.equal(weekly.weeks[0].week, '2025-12-29'); assert.equal(weekly.weeks[0].projectCount, 1);
  assert.equal(weekly.weeks[0].sessionCount, 2); assert.equal(weekly.weeks[0].projects[0].name, 'Merged project');
  assert.deepEqual(weekly, JSON.parse((await run([...weekFlags, '--json', '--no-index'])).stdout));
  const emptyPage = JSON.parse((await run([...weekFlags, '--json', '--page', '2'])).stdout);
  assert.deepEqual(emptyPage.weeks, []); assert.equal(emptyPage.total, 1); assert.equal(emptyPage.hasMore, false);
  assert.match((await run(weekFlags)).stdout, /共 1 周/);
  for (const flags of [['--weekly', '--timezone'], ['--weekly', '--timezone', 'invalid'], ['--project-map'], ['--timezone', 'UTC']]) {
    await assert.rejects(run(flags), /requires|time zone/i);
  }
}));

test('read-only index writes fall back to fresh source data across search, listings and readers', async t => fixture(async (dir, add) => {
  await add(claudeAdapter, 'readonly-session.jsonl', [
    user('readonly question', 'u1'),
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'echo hello' } }] } },
    { type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'hello' }] } },
    assistant('readonly answer', 'a2'),
  ]);
  await add(grokAdapter, 'readonly-artifact/chat_history.jsonl', [{ type: 'user', content: 'readonly artifact' }]);
  const artifact = path.join(dir, 'readonly-artifact/goal/plan.md');
  await fs.mkdir(path.dirname(artifact));
  await fs.writeFile(artifact, 'readonly plan');
  const db = await openStore();
  db.exec('PRAGMA query_only = ON');
  const warnings = t.mock.method(console, 'warn', () => {});
  try {
    const id = 'claude:readonly-session';
    const options = { useIndex: false };
    assert.deepEqual(await searchSessions('readonly'), await searchSessions('readonly', options));
    const first = await searchSessions('readonly', { sessionId: id, maxPerSession: 1 });
    assert.ok(first[0]!.nextCursor);
    const continuation = { sessionId: id, maxPerSession: 1, cursor: first[0]!.nextCursor };
    assert.deepEqual(await searchSessions('readonly', continuation), await searchSessions('readonly', { ...continuation, ...options }));
    assert.deepEqual(await listRecentSessions(), await listRecentSessions(options));
    assert.deepEqual(await listProjects(), await listProjects(options));
    assert.deepEqual(await loadSession(id), await loadSession(id, options));
    assert.deepEqual(await readTurnDirectory(id), await readTurnDirectory(id, options));
    const page = await readTurns(id, '1', { maxChars: 5 });
    assert.deepEqual(page, await readTurns(id, '1', { ...options, maxChars: 5 }));
    assert.deepEqual(await readTurns(id, '1', { maxChars: 5, cursor: page.nextCursor }), await readTurns(id, '1', { ...options, maxChars: 5, cursor: page.nextCursor }));
    assert.deepEqual(await readEvents(id, ['0']), await readEvents(id, ['0'], options));
    assert.deepEqual(await readOriginalRecords(id, ['0']), await readOriginalRecords(id, ['0'], options));
    assert.deepEqual(await readCall(id, 'c1'), await readCall(id, 'c1', options));
    assert.deepEqual(await readArtifact('grok:readonly-artifact', artifact), await readArtifact('grok:readonly-artifact', artifact, options));
    assert.ok(warnings.mock.callCount() > 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get()!.count, 0);
  } finally {
    db.exec('PRAGMA query_only = OFF');
    warnings.mock.restore();
  }
  assert.equal((await searchSessions('readonly')).length, 2, 'restored write access can use the index again');
  assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get()!.count, 2);
}));

test('read-only SQLite initialization falls back and closes failed store handles', async t => fixture(async (_dir, add) => {
  await add(claudeAdapter, 'init-session.jsonl', [user('question', 'u1')]);
  const db = await openStore();
  db.close(); resetStoreCache();
  const { DatabaseSync } = await import('node:sqlite');
  const exec = DatabaseSync.prototype.exec;
  const readonly = t.mock.method(DatabaseSync.prototype, 'exec', function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    if (sql === 'PRAGMA journal_mode = WAL') exec.call(this, 'PRAGMA query_only = ON');
    return exec.call(this, sql);
  });
  const close = t.mock.method(DatabaseSync.prototype, 'close');
  const warnings = t.mock.method(console, 'warn', () => {});
  try {
    assert.equal((await searchSessions('question')).length, 1);
    assert.equal((await listRecentSessions()).length, 1);
    assert.equal((await readTurns('claude:init-session', '1')).items[0]!.content, 'question');
    // Each attempt closes its read-only schema probe AND the failed writable handle.
    // Keep the protection check, and verify every connection is closed exactly once.
    assert.equal(close.mock.callCount(), 6);
    assert.equal(new Set(close.mock.calls.map(call => call.this)).size, 6);
    assert.equal(readonly.mock.calls.filter(call => call.arguments[0] === 'PRAGMA journal_mode = WAL').length, 3);
  } finally {
    readonly.mock.restore(); close.mock.restore(); warnings.mock.restore();
  }
}));

test('unwritable index directories fall back without truncating listings at the direct scan budget', async t => fixture(async (dir, add) => {
  for (let i = 0; i < 61; i++) await add(claudeAdapter, `denied-${i}.jsonl`, [user(`question ${i}`, `u${i}`)]);
  const mkdir = fsSync.mkdirSync;
  const warnings = t.mock.method(console, 'warn', () => {});
  try {
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      const denied = t.mock.method(fsSync, 'mkdirSync', ((target: fsSync.PathLike, options: unknown) => {
        if (target === dir) throw Object.assign(new Error('index directory is not writable'), { code });
        return mkdir(target, options as fsSync.MakeDirectoryOptions);
      }) as typeof fsSync.mkdirSync);
      try {
        assert.deepEqual(await searchSessions('question'), await searchSessions('question', { useIndex: false }));
        assert.deepEqual(await listRecentSessions({ limit: 100 }), await listRecentSessions({ limit: 100, scan: Infinity, useIndex: false }));
        assert.deepEqual(await listRecentSessions({ limit: 100, refresh: false }), await listRecentSessions({ limit: 100, scan: Infinity, useIndex: false }));
        assert.equal((await listRecentSessions({ limit: 100 })).length, 61);
        assert.deepEqual(await readTurns('claude:denied-60', '1'), await readTurns('claude:denied-60', '1', { useIndex: false }));
      } finally { denied.mock.restore(); }
    }
  } finally { warnings.mock.restore(); }
}));

test('corrupt indexes still report database errors instead of silently falling back', async t => fixture(async (dir, add) => {
  await add(claudeAdapter, 'corrupt-session.jsonl', [user('question', 'u1')]);
  const file = path.join(dir, 'index.db');
  await fs.writeFile(file, 'not a SQLite database');
  const warnings = t.mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(searchSessions('question'), /not a database/);
    await assert.rejects(listRecentSessions(), /not a database/);
    await assert.rejects(readTurns('claude:corrupt-session', '1'), /not a database/);
    assert.equal(warnings.mock.callCount(), 0);
  } finally {
    warnings.mock.restore();
    await fs.rm(file);
  }
}));

test('source permission errors are reported without blaming the index', async t => fixture(async (_dir, add) => {
  const candidate = await add(claudeAdapter, 'source-session.jsonl', [user('question', 'u1')]);
  const error = Object.assign(new Error('source is not readable'), { code: 'EACCES', path: candidate.path });
  const parse = t.mock.method(claudeAdapter, 'parse', async () => { throw error; });
  const warnings = t.mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(searchSessions('question'), (caught) => caught === error);
    await assert.rejects(readTurns('claude:source-session', '1'), (caught) => caught === error);
    assert.equal(warnings.mock.callCount(), 0);
  } finally { parse.mock.restore(); warnings.mock.restore(); }
}));

test('CLI fallback keeps JSON stdout valid even when caller edge recording cannot write', async () => fixture(async (dir) => {
  const home = path.join(dir, 'home');
  const sessions = path.join(home, '.claude/projects/-tmp-ws');
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, 'cli-session.jsonl'), JSON.stringify(user('original question', 'u1')) + '\n');
  const preload = path.join(dir, 'deny-index.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs';
const mkdir = fs.mkdirSync;
fs.mkdirSync = function (target, options) {
  if (target === process.env.DENIED_INDEX_DIRECTORY) throw Object.assign(new Error('index directory is not writable'), { code: 'EPERM' });
  return mkdir(target, options);
};
`);
  const env = { ...process.env, HOME: home, SESSION_READER_NO_INDEX: '0', SESSION_READER_CALLER_SESSION: 'claude:caller', DENIED_INDEX_DIRECTORY: dir };
  const args = ['--import', 'tsx', '--import', preload, 'bin/1session.ts'];
  const run = (command: string[]) => promisify(execFile)(process.execPath, [...args, ...command], { env });
  const result = await run(['turn', 'claude:cli-session', '1', '--json']);
  assert.equal(JSON.parse(result.stdout).items[0].content, 'original question');
  assert.match(result.stderr, /index.*not writable/i);
  const direct = await run(['turn', 'claude:cli-session', '1', '--json', '--no-index']);
  assert.deepEqual(JSON.parse(direct.stdout), JSON.parse(result.stdout));
  assert.doesNotMatch(direct.stderr, /index.*not writable/i);
  await assert.rejects(run(['index', '--all', '--global']), /index directory is not writable/);
}));

test('Claude preserves array user roles, native IDs, all existing titles and interleaved tool pairing', async () => fixture(async (_dir, add) => {
  const candidate = await add(claudeAdapter, 'claude-native.jsonl', [
    user('发布 npm', 'u1'), { type: 'ai-title', aiTitle: 'AI 发布标题' }, { type: 'custom-title', customTitle: '用户标题' },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', content: [
      { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'echo first' } },
      { type: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'echo second' } },
    ] } },
    { type: 'user', uuid: 'r2', message: { content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'Exit code 2\nsecond failed', is_error: true }] } },
    { type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'first okay', is_error: false }] } },
    assistant('已完成', 'a2'),
  ]);
  const normalized = await claudeAdapter.parse(candidate);
  assert.equal(normalized.turns[0]!.kind, 'user');
  assert.equal(normalized.turns[0]!.source?.nativeId, 'u1');
  assert.equal(normalized.turns[1]!.source?.parentId, 'u1');
  assert.equal(normalized.ref.title, '用户标题');
  assert.ok(normalized.ref.titles?.some((title) => title.text === 'AI 发布标题'));
  const calls = normalized.turns.filter((event) => event.kind === 'tool_call');
  assert.equal(toolResults(normalized.turns, calls[0]!)[0]!.toolResult, 'first okay');
  assert.deepEqual(commandLedger(normalized).map((record) => record.exitCode), [0, 2]);
  const page = await readCall('claude:claude-native', 'c1');
  assert.deepEqual(page.items.map((item) => item.kind), ['tool_call', 'tool_result']);
  assert.ok(!page.items.some((item) => item.content.includes('second failed')));
  const db = await openStore();
  const indexed = await indexSession(db, { adapter: claudeAdapter, candidate });
  assert.deepEqual(readSession(db, sessionRow(db, indexed.id)!), normalized);
}));

test('Codex and DSH retain record, turn and call identities without repeating side-channel actions', async () => fixture(async (_dir, add) => {
  const codex = await add(codexAdapter, 'codex-native.jsonl', [
    { type: 'session_meta', ordinal: 0, payload: { cwd: '/tmp/ws' } },
    { type: 'response_item', ordinal: 1, payload: { type: 'message', id: 'u1', role: 'user', content: [{ text: '检查' }] } },
    { type: 'response_item', ordinal: 2, payload: { type: 'function_call', call_id: 'c1', name: 'exec', arguments: '{"cmd":"ls"}' } },
    { type: 'event_msg', ordinal: 3, payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 'ls' } } },
    { type: 'response_item', ordinal: 4, payload: { type: 'function_call_output', call_id: 'c1', output: 'files' } },
  ]);
  const parsed = await codexAdapter.parse(codex);
  assert.equal(parsed.turns.length, 3);
  assert.equal(parsed.turns[0]!.source?.nativeId, 'ordinal:1');
  assert.deepEqual(parsed.turns.slice(1).map((event) => event.callId), ['c1', 'c1']);
  const dsh = await add(dshAdapter, 'dsh-native.jsonl', [
    { type: 'session', cwd: '/tmp/ws' },
    { type: 'session/title', seq: 1, data: { title: '落盘标题' } },
    { type: 'user/message', seq: 2, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '检查' }] } },
    { type: 'assistant/message', seq: 3, data: { turn: 9, message: { id: 'a1', content: [{ type: 'text', text: '执行' }, { type: 'tool-call' }] } } },
    { type: 'tool/call', seq: 4, data: { turn: 9, callId: 'c1', name: 'bash', arguments: { command: 'ls' } } },
    { type: 'tool/result', seq: 5, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ text: 'files' }], isError: false }] } } },
  ]);
  const session = await dshAdapter.parse(dsh);
  assert.equal(session.turns.filter((event) => event.kind === 'tool_call').length, 1);
  assert.equal(session.turns[1]!.source?.nativeTurnId, '9');
  assert.equal(session.turns[2]!.source?.nativeId, 'seq:4');
  assert.equal(session.turns[3]!.callId, 'c1');
}));

test('search covers persisted metadata, names, arguments and artifacts; index agrees with source', async () => fixture(async (dir, add) => {
  await add(grokAdapter, 'grok-native/chat_history.jsonl', [
    { type: 'user', prompt_index: 0, content: '开始' },
    { type: 'assistant', content: '保留完整交互', tool_calls: [{ id: 'c1', name: 'unique_tool_name', arguments: '{"path":"src/ledger.ts"}' }] },
    { type: 'tool_result', tool_call_id: 'c1', content: '错误 E1234' },
  ]);
  await fs.writeFile(path.join(dir, 'grok-native/summary.json'), JSON.stringify({ generated_title: '已落盘 AI 标题', session_summary: '已落盘会话概述', info: { cwd: '/tmp/ws' } }));
  await fs.mkdir(path.join(dir, 'grok-native/goal'));
  const artifact = path.join(dir, 'grok-native/goal/plan.md');
  await fs.writeFile(artifact, '# 计划\n产物尾部关键词 needle-artifact');
  for (const [query, area] of [['AI 标题', 'dialogue'], ['会话概述', 'dialogue'], ['unique_tool_name', 'tools'], ['src/ledger.ts', 'tools'], ['needle-artifact', 'artifacts']] as const) {
    const indexed = await searchSessions(query, { area });
    const parsed = await searchSessions(query, { area, useIndex: false });
    assert.equal(indexed.length, 1, query);
    assert.deepEqual(indexed, parsed, query);
  }
  assert.equal((await searchSessions('E1234')).length, 0, 'tool results are opt-in');
  const call = await readCall('grok:grok-native', 'c1');
  assert.equal(call.items[1]!.content, '错误 E1234');
  const combined = { area: 'tools' as const, terms: ['unique_tool_name', 'E1234'], operator: 'and' as const };
  const combinedHits = await searchSessions('ignored', combined);
  assert.equal(combinedHits[0]!.totalMatches, 2, 'AND terms may span a native call and its result');
  assert.equal(combinedHits[0]!.groups!.length, 1);
  assert.deepEqual(combinedHits, await searchSessions('ignored', { ...combined, useIndex: false }));
  const page = await readArtifact('grok:grok-native', artifact);
  assert.match(page.items[0]!.content, /needle-artifact/);
  await fs.writeFile(artifact, 'updated-artifact');
  assert.equal((await searchSessions('updated-artifact', { area: 'artifacts' })).length, 1, 'nested artifact changes invalidate the index');
}));

test('Antigravity searches recovered output tails and refreshes when a step side file changes', async () => fixture(async (dir, add) => {
  await add(antigravityAdapter, 'antigravity-native/.system_generated/logs/transcript.jsonl', [
    { step_index: 0, type: 'USER_INPUT', content: '检查' },
    { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { Cwd: '/tmp/ws', CommandLine: 'ls' } }] },
    { step_index: 2, type: 'GENERIC', content: 'short', truncated_fields: ['content'] },
  ]);
  const output = path.join(dir, 'antigravity-native/.system_generated/steps/2/output.txt');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, 'full output\nTAIL_KEYWORD');
  const hit = (await searchSessions('TAIL_KEYWORD', { area: 'tools' }))[0]!;
  assert.equal(hit.matches[0]!.index, 2);
  const page = await readEvents('antigravity:antigravity-native', [hit.matches[0]!.locator!]);
  assert.equal(page.items[0]!.content, 'full output\nTAIL_KEYWORD');
  assert.equal(page.items[0]!.recovered, true);
  assert.equal((await readTurns('antigravity:antigravity-native', '1')).tools[0]!.association, 'unconfirmed');
  await fs.writeFile(output, 'full output\nNEW_KEYWORD');
  assert.equal((await searchSessions('NEW_KEYWORD', { area: 'tools' })).length, 1);
  await fs.rm(output);
  const missing = await readEvents('antigravity:antigravity-native', ['2']);
  assert.ok(missing.items[0]!.truncationNote);
  assert.equal(missing.items[0]!.recovered, undefined);
}));

test('literal terms, grouping, relevance, continuation and exact session scoping are deterministic', async () => fixture(async (_dir, add) => {
  await add(claudeAdapter, 'abcdef-session.jsonl', [
    user('先发布 npm', 'u1'), assistant('发布 npm 已完成', 'a1'),
    user('第二轮', 'u2', '2026-01-02T00:00:00Z'), assistant('后来发布 npm', 'a2', '2026-01-02T00:00:01Z'),
  ]);
  const first = await searchSessions('发布 npm', { kinds: ['assistant'], maxPerSession: 1, sessionId: 'claude:abcdef-session' });
  assert.equal(first[0]!.matches[0]!.turn, 2, 'newest relevant reply wins');
  assert.equal(first[0]!.totalMatches, 2);
  const next = await searchSessions('发布 npm', { kinds: ['assistant'], maxPerSession: 1, sessionId: 'claude:abcdef-session', cursor: first[0]!.nextCursor });
  assert.equal(next[0]!.matches[0]!.turn, 1);
  assert.ok(!next[0]!.nextCursor);
  const grouped = await searchSessions('发布 npm', { kinds: ['user', 'assistant'], maxPerSession: 10 });
  assert.equal(grouped[0]!.groups!.length, 2);
  const and = await searchSessions('ignored', { terms: ['发布', '完成'], operator: 'and', kinds: ['assistant'] });
  assert.equal(and[0]!.totalMatches, 1);
  const or = await searchSessions('ignored', { terms: ['发布', '第二轮'], operator: 'or', kinds: ['user', 'assistant'] });
  assert.equal(or[0]!.totalMatches, 4);
  await assert.rejects(searchSessions('other', { cursor: first[0]!.nextCursor }), /cursor/);
  const page = await readTurns('claude:abcdef-session', '1-2');
  assert.deepEqual(page.items.map((item) => item.content), ['先发布 npm', '发布 npm 已完成', '第二轮', '后来发布 npm']);
}));

test('native locators survive appended records; positional locators refuse rewrites', async () => fixture(async (_dir, add) => {
  const candidate = await add(claudeAdapter, 'stable-session.jsonl', [user('原文', 'native-u'), assistant('回答', 'native-a')]);
  const initial = await claudeAdapter.parse(candidate);
  const locator = initial.turns[1]!.locator!;
  await fs.appendFile(candidate.path, JSON.stringify(user('新增', 'native-next')) + '\n');
  const reread = await readEvents('claude:stable-session', [locator]);
  assert.equal(reread.items[0]!.content, '回答');
  const fallback = await add(claudeAdapter, 'fallback-session.jsonl', [{ type: 'user', message: { content: '没有 native ID' } }]);
  const old = (await claudeAdapter.parse(fallback)).turns[0]!.locator!;
  await fs.writeFile(fallback.path, JSON.stringify({ type: 'user', message: { content: '已被重写' } }) + '\n');
  await assert.rejects(readEvents('claude:fallback-session', [old]), /source changed/);
}));

test('content pagination reconstructs exact strings, rejects stale cursors and hides reasoning by default', () => {
  const original = '第一行\n```ts\nconst emoji = "😀";\n```\n最后一行';
  const events: TurnEvent[] = [{ id: 'e1', index: 0, kind: 'assistant', text: original }];
  let page = contentPage(events, { maxChars: 7 });
  let restored = page.items.map((item) => item.content).join('');
  const cursor = page.nextCursor!;
  while (page.nextCursor) {
    page = contentPage(events, { maxChars: 7, cursor: page.nextCursor });
    restored += page.items.map((item) => item.content).join('');
  }
  assert.equal(restored, original);
  assert.throws(() => contentPage([{ ...events[0]!, text: 'changed' }], { cursor }), /source changed/);
  assert.equal(callsIn([{ id: 'call', index: 0, kind: 'tool_call' }, { id: 'result', index: 1, kind: 'tool_result', toolResult: 'adjacent' }])[0]!.association, 'unconfirmed');
});

test('broad regexes bound reported ranges while preserving complete original text', async () => fixture(async (_dir, add) => {
  const text = 'x'.repeat(1_000_000);
  await add(claudeAdapter, 'broad-session.jsonl', [user('question', 'u1'), assistant(text, 'a1')]);
  const hit = (await searchSessions('.', { regex: true, kinds: ['assistant'] }))[0]!;
  assert.equal(hit.totalMatches, 1);
  assert.equal(hit.matches[0]!.fields![0]!.ranges.length, 20);
  assert.equal(hit.matches[0]!.fields![0]!.hasMoreRanges, true);
  assert.equal((await readEvents('claude:broad-session', [hit.matches[0]!.locator!], { maxChars: 1_000_000 })).items[0]!.content, text);
}));

test('resolveSession accepts unique prefixes and refuses colliding eight-character prefixes', async () => fixture(async (_dir, add) => {
  for (const id of ['01a11fb0-1111', '01a11fb0-2222']) {
    await add(codexAdapter, `${id}.jsonl`, [
      { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { cwd: '/tmp/ws' } },
    ]);
  }
  for (const prefix of ['01a11fb0-1', 'codex:01a11fb0-1', 'codex:01a11fb0-1111']) {
    const resolved = await resolveSession(prefix);
    assert.ok(resolved, 'unique prefix lookup should resolve');
    assert.equal(resolved.ref.id, '01a11fb0-1111');
    assert.equal(resolved.ref.provider, 'codex');
  }
  for (const prefix of ['01a11fb0', 'codex:01a11fb0']) {
    await assert.rejects(resolveSession(prefix), /ambiguous.*codex:01a11fb0-1111.*codex:01a11fb0-2222/);
  }
  assert.equal(await resolveSession('01a11'), undefined, 'prefixes shorter than six characters are refused');
}));

test('a workspace filter covers the whole subtree, and / filters nothing', async () => fixture(async (_dir, add) => {
  const parent = '/tmp/workspace-scope';
  for (const [name, workspace] of [
    ['parent', parent], ['child', `${parent}/child`], ['grandchild', `${parent}/child/grandchild`],
    ['sibling', `${parent}-other`], ['unknown', undefined],
  ]) {
    await add(codexAdapter, `${name}.jsonl`, [
      { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { cwd: workspace } },
    ]);
  }
  for (const useIndex of [true, false]) {
    const options = { limit: 20, scan: Infinity, useIndex };
    const inParent = await listRecentSessions({ ...options, workspace: parent });
    assert.deepEqual(inParent.map((ref) => ref.id).sort(), ['child', 'grandchild', 'parent']);
    const inChild = await listRecentSessions({ ...options, workspace: `${parent}/child` });
    assert.deepEqual(inChild.map((ref) => ref.id).sort(), ['child', 'grandchild']);
    const root = await listRecentSessions({ ...options, workspace: '/' });
    const unfiltered = await listRecentSessions(options);
    assert.deepEqual(root, unfiltered);
    assert.equal(root.length, 5, 'global scope includes sessions without a workspace');
  }
}));

test('the index and the parsing path agree on search order and turn handles', async () => fixture(async (_dir, add) => {
  for (const [name, day] of [['parity-b', 2], ['parity-z', 3], ['parity-a', 2]] as const) {
    const at = (second: number) => `2026-01-0${day}T00:00:0${second}Z`;
    await add(claudeAdapter, `${name}.jsonl`, [
      user('needle first question', 'u1', at(0)),
      assistant('needle first answer', 'a1', at(1)),
      user('needle second question', 'u2', at(2)),
      assistant('needle second answer', 'a2', at(3)),
    ]);
  }
  for (const sort of ['relevance', 'time'] as const) {
    const options = { provider: 'claude', limit: 3, maxPerSession: 3, regex: true, sort } as const;
    const indexed = await searchSessions('.', options);
    const parsed = await searchSessions('.', { ...options, useIndex: false });
    assert.deepEqual(indexed, parsed);
    assert.deepEqual(indexed.map((hit) => hit.session.id), ['parity-z', 'parity-a', 'parity-b']);
    for (const hit of indexed) {
      assert.equal(hit.totalMatches, 5);
      assert.deepEqual(hit.matches.map((match) => `T${match.turn}·E${match.index}`), ['T0·E-1', 'T2·E3', 'T2·E2']);
    }
  }
}));

test('short IDs refuse collisions across providers and within an index', async () => fixture(async (_dir, add) => {
  await add(claudeAdapter, 'abcdef-one.jsonl', [user('one', 'u1')]);
  await add(claudeAdapter, 'abcdef-two.jsonl', [user('two', 'u2')]);
  await searchSessions('one');
  const db = await openStore();
  assert.throws(() => findSessionRow(db, 'abcdef'), /ambiguous.*abcdef-one.*abcdef-two/);
  await assert.rejects(readTurns('abcdef', '1'), /ambiguous/);
  assert.equal(findSessionRow(db, 'claude:abcdef-one')!.native_id, 'abcdef-one');
  assert.throws(() => selectSession([{ id: 'claude:same-id', native_id: 'same-id', provider: 'claude' }, { id: 'codex:same-id', native_id: 'same-id', provider: 'codex' }], 'same-id'), /ambiguous/);
}));

test('a partially populated index never resolves an ambiguous source prefix', async () => fixture(async (_dir, add) => {
  const one = await add(claudeAdapter, 'partial-one.jsonl', [user('one', 'u1')]);
  await indexSession(await openStore(), { adapter: claudeAdapter, candidate: one });
  await add(claudeAdapter, 'partial-two.jsonl', [user('two', 'u2')]);
  await assert.rejects(readTurns('partial', '1'), /ambiguous/);
  await assert.rejects(searchSessions('one', { sessionId: 'partial' }), /ambiguous/);
  assert.equal((await readTurns('claude:partial-one', '1')).items[0]!.content, 'one');
}));

test('dialogue and preview keep every plain text message in order; raw records retain hidden fields', async () => fixture(async (_dir, add) => {
  const candidate = await add(claudeAdapter, 'original-session.jsonl', [
    user('完整问题\n```text\n原文\n```', 'u1'),
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [
      { type: 'thinking', thinking: 'private thought' },
      { type: 'text', text: '先检查\n```ts\nconst a = 1;\n```' },
      { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'echo hello' } },
      { type: 'text', text: '执行中间的回复' },
    ] } },
    { type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'hello', is_error: false }] } },
    assistant('最后的回复', 'a2'),
  ]);
  const original = (await fs.readFile(candidate.path, 'utf8')).split('\n')[1]!;
  const normalized = await claudeAdapter.parse(candidate);
  const page = await readTurns('claude:original-session', '1');
  assert.deepEqual(page.items.map((item) => item.content), ['完整问题\n```text\n原文\n```', '先检查\n```ts\nconst a = 1;\n```', '执行中间的回复', '最后的回复']);
  assert.deepEqual(page, await readTurns('claude:original-session', '1', { useIndex: false }));
  const preview = previewTurns(normalized)[0]!;
  assert.deepEqual(preview.messages.map((event) => event.text), page.items.map((item) => item.content));
  assert.equal(preview.thinking, '');
  assert.equal('toolArgs' in preview.toolCalls[0]!, false);
  const locator = page.items[1]!.locator!;
  const raw = await readOriginalRecords('claude:original-session', [locator], { maxChars: 10 });
  let recovered = raw.items.map((item) => item.content).join('');
  let cursor = raw.nextCursor;
  while (cursor) {
    const next = await readOriginalRecords('claude:original-session', [locator], { cursor, maxChars: 10 });
    recovered += next.items.map((item) => item.content).join(''); cursor = next.nextCursor;
  }
  assert.equal(recovered, original);
  assert.equal(raw.items[0]!.field, 'record');
  const directory = await readTurnDirectory('claude:original-session');
  assert.deepEqual(directory.turns, (await readTurnDirectory('claude:original-session', { useIndex: false })).turns);
}));

test('HTTP content selectors use the same original and call pagination as the shared reader', async () => fixture(async (_dir, add) => {
  await add(claudeAdapter, 'http-session.jsonl', [user('question', 'u1'), assistant('answer', 'a1')]);
  const page = await readTurns('claude:http-session', '1');
  const locator = page.items[1]!.locator!;
  const server = await serveWeb({ port: 0, cwd: '/tmp/ws' });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session-reader`;
  try {
    const params = new URLSearchParams({ event: locator, maxChars: '3' });
    const response = await fetch(`${base}/session/claude%3Ahttp-session/content?${params}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), await readEvents('claude:http-session', [locator], { maxChars: 3 }));
    params.set('raw', 'true');
    const raw = await fetch(`${base}/session/claude%3Ahttp-session/content?${params}`);
    assert.equal(raw.status, 200);
    assert.deepEqual(await raw.json(), await readOriginalRecords('claude:http-session', [locator], { maxChars: 3 }));
    const search = await fetch(`${base}/search?q=answer&scope=global`);
    assert.deepEqual((await search.json() as { hits: unknown }).hits, await searchSessions('answer'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}));
