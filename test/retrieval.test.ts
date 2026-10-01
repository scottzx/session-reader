import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adapters } from '../src/resolver.js';
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
