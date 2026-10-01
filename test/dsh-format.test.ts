import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { dshAdapter } from '../src/parsers/dsh.js';
import { readCall, readEvents, readOriginalRecords, readTurnDirectory, readTurns } from '../src/reader.js';
import { searchSessions } from '../src/search.js';
import { openStore, resetStoreCache } from '../src/store/db.js';
import { indexSession } from '../src/store/indexer.js';
import type { SessionCandidate } from '../src/parsers/provider.js';

const id = '43782a8a-68a3-4cfd-a42c-1d40b5bd0a1e';
const sessionId = `dsh:${id}`;
const title = '合并到main并发布npm包';

async function fixture(t: TestContext, run: (dir: string, write: (version: number, lines: unknown[]) => Promise<SessionCandidate>) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), '1session-dsh-format-'));
  const dir = path.join(home, '.dsh', 'sessions', 'project', `session-${id}`);
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.SESSION_READER_DB;
  process.env.SESSION_READER_DB = path.join(home, 'index.db');
  resetStoreCache();
  t.mock.method(os, 'homedir', () => home);
  const write = async (version: number, lines: unknown[]) => {
    const file = path.join(dir, `session.v${version}.jsonl.zstd`);
    await fs.writeFile(file, Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(line) + '\n')))));
    const stat = await fs.stat(file);
    return { id, path: file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  };
  try { await run(dir, write); }
  finally {
    (await openStore()).close(); resetStoreCache(); t.mock.restoreAll();
    if (previous === undefined) delete process.env.SESSION_READER_DB; else process.env.SESSION_READER_DB = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
}

function transcript(version: number) {
  const lines: Record<string, unknown>[] = [{ type: 'session', version, id: `session-${id}`, cwd: '/tmp/feature-blueprint', createdAt: 1_700_000_000_000 }];
  const add = (type: string, data: unknown) => lines.push({ type, seq: lines.length, time: 1_700_000_000_000 + lines.length * 1000, data });
  add('session/title', { title: '初始标题' });
  for (let turn = 1; turn <= 9; turn++) {
    add('turn/start', { turn });
    add('user/message', { id: `u${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: turn === 9 ? 'B' : `第 ${turn} 轮` }] });
    add('user/message', { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'injected context' }] });
    add('assistant/message', { turn, message: { id: `a${turn}`, content: [{ type: 'reasoning', text: 'private thought' }, { type: 'text', text: `第 ${turn} 轮回复` }, { type: 'tool-call', id: `c${turn}` }] } });
    if (turn < 9) add('turn/end', { turn, reason: { kind: 'completed' } });
  }
  add('session/title', { title });
  add('tool/call', { turn: 9, callId: 'publish', name: 'bash', arguments: '{"command":"npm publish @1agents/feature-blueprint"}' });
  add('tool/call', { turn: 9, callId: 'check', name: 'bash', arguments: { command: 'npm view version' } });
  add('tool/result', { turn: 9, message: { id: 'result-check', role: 'tool', toolCallId: 'check', isError: true, content: [{ type: 'text', text: 'check failed [Command finished with exit code 2]' }] } });
  add('tool/result', { turn: 9, message: { id: 'result-publish', role: 'tool', toolCallId: 'publish', isError: false, content: [{ type: 'text', text: 'published 0.2.1 [Command finished with exit code 0]' }] } });
  add('assistant/message', { turn: 9, message: { id: 'final', content: [{ type: 'text', text: '完整原文：发布成功\n等待安装验证' }] } });
  return lines;
}

test('DSH v4 discovers the current transcript and reads title, turn, native calls and original records', async (t) => fixture(t, async (_dir, write) => {
  await write(2, [{ type: 'session', version: 2 }]);
  const lines = transcript(4);
  const candidate = await write(4, lines);
  assert.deepEqual((await dshAdapter.listCandidates()).map((item) => item.path), [candidate.path]);
  assert.equal((await dshAdapter.scanRef(candidate)).title, title);
  const parsed = await dshAdapter.parse(candidate);
  assert.equal(parsed.ref.title, title);
  assert.ok(parsed.ref.titles?.some((item) => item.text === '初始标题'));
  assert.equal(parsed.turns.filter((event) => event.kind === 'user').length, 9);
  assert.equal(parsed.turns.filter((event) => event.kind === 'tool_call').length, 2);
  assert.equal(parsed.turns.at(-1)!.source?.nativeTurnId, '9');
  assert.deepEqual(parsed.turns.filter((event) => event.kind === 'tool_result').map((event) => [event.callId, event.exitCode, event.isError]), [['check', 2, true], ['publish', 0, false]]);
  for (const useIndex of [true, false]) {
    const hits = await searchSessions(title, { provider: 'dsh', useIndex });
    assert.equal(hits[0]!.session.id, id);
    assert.equal(hits[0]!.matches[0]!.kind, 'metadata');
    assert.equal((await searchSessions('private thought', { provider: 'dsh', useIndex })).length, 0);
    const page = await readTurns(sessionId, '9', { useIndex });
    assert.deepEqual(page.items.map((item) => item.content), ['B', '第 9 轮回复', '完整原文：发布成功\n等待安装验证']);
    assert.equal(page.summaries[0]!.no, 9);
    assert.equal((await readTurnDirectory(sessionId, { useIndex })).turns[8]!.status, 'unfinished');
    const call = await readCall(sessionId, 'publish', { useIndex });
    assert.deepEqual(call.items.map((item) => item.kind), ['tool_call', 'tool_result']);
    assert.equal(call.items[1]!.content, 'published 0.2.1 [Command finished with exit code 0]');
    const toolHits = await searchSessions('ignored', { provider: 'dsh', useIndex, area: 'tools', terms: ['@1agents/feature-blueprint', 'published 0.2.1'] });
    assert.equal(toolHits[0]!.groups![0]!.callId, 'publish');
    const raw = await readOriginalRecords(sessionId, [call.items[1]!.locator!], { useIndex });
    assert.equal(JSON.parse(raw.items[0]!.content).data.message.id, 'result-publish');
  }
  const oldLocator = parsed.turns.at(-1)!.locator!;
  await write(4, [...lines, { type: 'turn/end', seq: lines.length, time: 1_700_000_100_000, data: { turn: 9, reason: { kind: 'completed' } } }]);
  assert.equal((await readEvents(sessionId, [oldLocator])).items[0]!.content, '完整原文：发布成功\n等待安装验证');
  assert.equal((await readTurnDirectory(sessionId)).turns[8]!.status, 'completed');
}));

test('an indexed DSH ID follows migration from v2 to v4 without a global sweep', async (t) => fixture(t, async (_dir, write) => {
  const old = await write(2, transcript(2));
  await indexSession(await openStore(), { adapter: dshAdapter, candidate: old });
  const current = await write(4, transcript(4));
  const originalDiscovery = dshAdapter.listCandidates;
  t.mock.method(dshAdapter, 'listCandidates', async () => { throw new Error('must not enumerate sessions'); });
  assert.equal((await readTurns(sessionId, '9')).session.path, current.path);
  const hits = await searchSessions(title, { sessionId });
  assert.equal(hits[0]!.session.path, current.path);
  dshAdapter.listCandidates = originalDiscovery;
}));

test('unsupported DSH versions are reported rather than silently read as an older transcript', async (t) => fixture(t, async (_dir, write) => {
  const warnings: string[] = [];
  t.mock.method(process, 'emitWarning', (message: string | Error) => { warnings.push(String(message)); });
  await write(4, transcript(4));
  const future = await write(9, [{ type: 'session', version: 9 }]);
  assert.equal((await dshAdapter.listCandidates()).length, 0);
  assert.ok(warnings.some((message) => message.includes('v9') && message.includes(future.path)));
  const output = await promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve('bin/1session.ts'), 'list', '--provider', 'dsh', '--global', '--no-index', '--json'], { env: { ...process.env, HOME: os.homedir() } });
  assert.deepEqual(JSON.parse(output.stdout), []);
  assert.ok(output.stderr.includes('SESSION_FORMAT_UNSUPPORTED') && output.stderr.includes(future.path));
  await fs.rm(future.path);
  const mismatch = await write(4, [{ type: 'session', version: 9 }]);
  await assert.rejects(dshAdapter.parse(mismatch), /unsupported DSH.*v9/i);
  assert.ok(warnings.some((message) => message.includes(mismatch.path)));
}));
