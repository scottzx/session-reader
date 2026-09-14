import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { antigravityAdapter, workspaceFromTrajectoryBlob } from '../src/parsers/antigravity.js';
import { claudeAdapter } from '../src/parsers/claude.js';
import { codexAdapter } from '../src/parsers/codex.js';
import { dshAdapter } from '../src/parsers/dsh.js';
import { grokAdapter, workspaceFromProjectDir } from '../src/parsers/grok.js';
import type { ProviderAdapter, SessionCandidate } from '../src/parsers/provider.js';
import type { NormalizedSession, TurnEvent } from '../src/types.js';
import { aggregateWorkspaceSessions } from '../src/aggregator.js';
import { distillSession } from '../src/distiller.js';
import { listRecentSessions, parseSince, resolveSession } from '../src/resolver.js';
import { echoFolder, isCallerSession, searchSessions, type Candidate } from '../src/search.js';
import { buildOverview } from '../src/overview.js';
import { classifyUserTurn } from '../src/classify.js';
import {
  eventDetail,
  parseEventSpec,
  summarizeTurns,
  turnDetail,
  turnNoAt,
  turnStarts,
  turnStartsFrom,
} from '../src/turns.js';
import { commandLedger, errorLedger, fileLedger, jobLedger } from '../src/ledger.js';
import { fileWrites, resolveWritePath, stripHeredocs } from '../src/writes.js';
import { canonicalizePath, isInside, slugifyWorkspace } from '../src/util/paths.js';
import { decodeZstd, frameRanges } from '../src/util/zstd.js';
import { looksLikeInstructions, stripPromptEnvelope } from '../src/util/text.js';
import { installSkill, skillStatus, uninstallSkill } from '../src/skill.js';
import { buildManifest, sessionUri } from '../src/serve/node.js';
import { nodeIdentity as sharedIdentity, resetIdentityCache } from '@1agents/dreammate-node';
import { createServer } from '../src/serve/http.js';

const VALID_KINDS = new Set(['user', 'assistant', 'thinking', 'tool_call', 'tool_result']);

test('canonicalizePath normalizes ~, file:// URIs and percent-encoding', () => {
  assert.equal(canonicalizePath('~'), canonicalizePath(os.homedir()));
  assert.equal(canonicalizePath('file:///tmp/a%20b/'), canonicalizePath('/tmp/a b'));
  assert.equal(canonicalizePath('/tmp/x/y/../y'), canonicalizePath('/tmp/x/y'));
});

test('slugifyWorkspace matches the Claude project directory naming', () => {
  assert.equal(
    slugifyWorkspace('/Users/dev/Documents/01-开发项目/demo/my_app'),
    '-Users-dev-Documents-01------demo-my-app',
  );
});

test('isInside covers the directory itself and its descendants', () => {
  assert.ok(isInside('/a/b', '/a/b'));
  assert.ok(isInside('/a/b', '/a/b/c'));
  assert.ok(!isInside('/a/b', '/a/bc'));
});

test('stripPromptEnvelope keeps only the real request', () => {
  const raw = '<USER_REQUEST>\nbuild it\n</USER_REQUEST>\n<ADDITIONAL_METADATA>noise</ADDITIONAL_METADATA>';
  assert.equal(stripPromptEnvelope(raw), 'build it');
  assert.ok(looksLikeInstructions('# AGENTS.md instructions\n<INSTRUCTIONS>'));
});

test('parseSince understands relative windows and ISO dates', () => {
  const day = parseSince('1d');
  assert.ok(day && Math.abs(Date.now() - day - 86_400_000) < 2_000);
  assert.equal(parseSince('2026-01-02'), Date.parse('2026-01-02'));
  assert.equal(parseSince(undefined), undefined);
});

/** Claude records its own titles after the opening prompt; both must win over it. */
test('claude: scanRef prefers the session title over the first prompt', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-reader-'));
  const write = async (name: string, lines: unknown[]) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'));
    return { id: name.replace(/\.jsonl$/, ''), path: file, mtimeMs: Date.now(), sizeBytes: 0 };
  };
  const prompt = { type: 'user', cwd: '/tmp/ws', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } };

  const ai = await write('ai.jsonl', [prompt, { type: 'ai-title', aiTitle: '发布 npm 包' }]);
  assert.equal((await claudeAdapter.scanRef(ai)).title, '发布 npm 包');
  assert.equal((await claudeAdapter.parse(ai)).ref.title, '发布 npm 包');

  const both = await write('both.jsonl', [prompt, { type: 'ai-title', aiTitle: '发布 npm 包' }, { type: 'custom-title', customTitle: '我改的标题' }]);
  assert.equal((await claudeAdapter.scanRef(both)).title, '我改的标题');

  const plain = await write('plain.jsonl', [prompt]);
  assert.equal((await claudeAdapter.scanRef(plain)).title, 'hi');
});

/**
 * Agents that compress their transcripts append one frame per flush, so the
 * file is a run of complete frames. Node's own zstd calls stop after the first.
 */
test('zstd: a transcript of appended frames decodes whole, a torn tail is dropped', () => {
  const parts = [
    '{"type":"session","cwd":"/tmp/ws"}\n',
    '{"type":"user/message","seq":1}\n{"type":"tool/call","seq":2}\n',
    '{"type":"turn/end","seq":3}\n',
  ].map((text) => zlib.zstdCompressSync(Buffer.from(text)));

  const whole = Buffer.concat(parts);
  assert.equal(frameRanges(whole).length, 3);
  assert.equal(decodeZstd(whole).split('\n').filter(Boolean).length, 4);
  // Node stops at the first frame, which is the bug this walker exists for.
  assert.equal(zlib.zstdDecompressSync(whole).toString().split('\n').filter(Boolean).length, 1);

  // A session still being written ends mid-frame; everything before it stands.
  const torn = Buffer.concat([...parts.slice(0, 2), parts[2]!.subarray(0, 5)]);
  assert.equal(decodeZstd(torn).split('\n').filter(Boolean).length, 3);
});

test('grok: the project directory decodes back to the exact cwd', () => {
  assert.equal(
    workspaceFromProjectDir('%2Ftmp%2F01-%E5%BC%80%E5%8F%91%2Fapp'),
    canonicalizePath('/tmp/01-开发/app'),
  );
});

/** DSH records turn/step boundaries natively and flags its own failures. */
test('dsh: reads a compressed session, its title, usage and exit codes', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), '1session-dsh-'));
  const dir = path.join(home, 'session-11111111-2222-3333-4444-555555555555');
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    { type: 'session', version: 2, id: 'session-1', createdAt: 1_700_000_000_000, cwd: '/tmp/ws' },
    { type: 'turn/start', seq: 1, time: 1_700_000_001_000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: 1_700_000_001_000,
      data: { content: [{ type: 'text', text: '装一下 mdns' }], source: { kind: 'user' } },
    },
    {
      type: 'user/message',
      seq: 3,
      time: 1_700_000_001_500,
      data: { content: [{ type: 'text', text: 'skill catalogue' }], source: { kind: 'skill-catalog' } },
    },
    {
      type: 'assistant/message',
      seq: 4,
      time: 1_700_000_002_000,
      data: {
        turn: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'think' },
            { type: 'text', text: '先试连接' },
            { type: 'tool-call', text: '' },
          ],
          source: { kind: 'model', provider: 'spark', model: 'test-model' },
        },
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 34, cacheReadTokens: 20 },
      },
    },
    {
      type: 'tool/call',
      seq: 5,
      time: 1_700_000_003_000,
      data: { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ssh host true"}' },
    },
    {
      type: 'tool/result',
      seq: 6,
      time: 1_700_000_004_000,
      data: {
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              isError: true,
              content: [{ type: 'text', text: 'Host key verification failed. [exit code: 255]' }],
            },
          ],
        },
      },
    },
    { type: 'session/title', seq: 7, time: 1_700_000_005_000, data: { title: '装 mdns' } },
    { type: 'turn/end', seq: 8, time: 1_700_000_006_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  // Two frames, so the fixture exercises the appending the real files do.
  await fs.writeFile(
    path.join(dir, 'session.v2.jsonl.zstd'),
    Buffer.concat(
      [lines.slice(0, 4), lines.slice(4)].map((chunk) =>
        zlib.zstdCompressSync(Buffer.from(`${chunk.map((line) => JSON.stringify(line)).join('\n')}\n`)),
      ),
    ),
  );
  const stat = await fs.stat(path.join(dir, 'session.v2.jsonl.zstd'));
  const candidate = {
    id: '11111111-2222-3333-4444-555555555555',
    path: path.join(dir, 'session.v2.jsonl.zstd'),
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };

  const ref = await dshAdapter.scanRef(candidate);
  assert.equal(ref.title, '装 mdns');
  assert.equal(ref.workspace, canonicalizePath('/tmp/ws'));

  const session = await dshAdapter.parse(candidate);
  assert.deepEqual(
    session.turns.map((turn) => turn.kind),
    ['user', 'thinking', 'assistant', 'tool_call', 'tool_result'],
  );
  // Injected catalogues are not the user speaking.
  assert.equal(session.stats.extras['injected:skill-catalog'], 1);
  // A `tool-call` block restates the `tool/call` record; counting both doubles it.
  assert.equal(session.turns.filter((turn) => turn.kind === 'tool_call').length, 1);
  assert.equal(session.turns.at(-1)!.exitCode, 255);
  assert.equal(session.turns.at(-1)!.isError, true);
  assert.deepEqual(session.stats.models, ['test-model']);
  // Cache reads are reported beside input, never inside it.
  assert.deepEqual(session.stats.tokens, { input: 10, output: 4, total: 14, cacheRead: 20 });
  assert.deepEqual(session.stats.turnBoundaries, [
    {
      id: '1',
      startedAt: new Date(1_700_000_001_000).toISOString(),
      endedAt: new Date(1_700_000_006_000).toISOString(),
      durationMs: 5000,
      completed: true,
    },
  ]);

  // A session can be opened and never titled. The index stores an absent
  // column as absent, so the ref must omit the key rather than set it to
  // `undefined` — otherwise a cached ref stops equalling a parsed one.
  const bare = path.join(home, 'session-99999999-2222-3333-4444-555555555555');
  await fs.mkdir(bare, { recursive: true });
  const barePath = path.join(bare, 'session.v2.jsonl.zstd');
  await fs.writeFile(
    barePath,
    zlib.zstdCompressSync(
      Buffer.from(`${JSON.stringify({ type: 'session', version: 2, id: 'session-2' })}\n`),
    ),
  );
  const bareCandidate = { id: 'x', path: barePath, mtimeMs: Date.now(), sizeBytes: 1 };
  for (const empty of [await dshAdapter.scanRef(bareCandidate), (await dshAdapter.parse(bareCandidate)).ref]) {
    assert.ok(!('title' in empty), 'an untitled session must not carry a title key');
    assert.ok(!('workspace' in empty), 'a session with no cwd must not carry a workspace key');
  }
  await fs.rm(home, { recursive: true, force: true });
});

/**
 * Grok's transcript carries no clock at all: the times, the outcomes and the
 * background receipts all live in the files beside it.
 */
test('grok: joins the transcript to the side files that hold the clock', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), '1session-grok-'));
  const dir = path.join(home, '%2Ftmp%2Fws', '019ff70d-f3a1-7a92-bd32-f7fe40f198fe');
  await fs.mkdir(dir, { recursive: true });
  const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

  await fs.writeFile(
    path.join(dir, 'summary.json'),
    JSON.stringify({
      info: { id: 'x', cwd: '/tmp/ws' },
      session_summary: '',
      generated_title: '整理索引',
      created_at: '2026-08-12T17:38:34.551571Z',
      updated_at: '2026-08-12T17:49:25.712891Z',
      current_model_id: 'grok-4.6',
      head_branch: 'main',
    }),
  );
  await fs.writeFile(
    path.join(dir, 'chat_history.jsonl'),
    jsonl([
      { type: 'system', content: 'you are grok' },
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: macos\n</user_info>\n<rules>none</rules>' }] },
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>\n整理 202503\n</user_query>' }] },
      { type: 'user', synthetic_reason: 'system_reminder', content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '先读规则' }] },
      {
        type: 'assistant',
        content: '先读规则再动手',
        model_id: 'grok-4.6-build',
        tool_calls: [{ id: 'call-1', name: 'write', arguments: '{"file_path":"/tmp/ws/index.md"}' }],
      },
      { type: 'tool_result', tool_call_id: 'call-1', content: 'wrote' },
      {
        type: 'user',
        synthetic_reason: 'task_completed',
        prompt_index: 1,
        content: [
          {
            type: 'text',
            text: '<system-reminder>\nBackground task "call-9" completed (exit code: 1).\nCommand: sleep 1\n</system-reminder>',
          },
        ],
      },
    ]),
  );
  await fs.writeFile(
    path.join(dir, 'events.jsonl'),
    jsonl([
      { ts: '2026-08-12T17:38:37.645Z', type: 'turn_started', turn_number: 0 },
      { ts: '2026-08-12T17:38:53.428Z', type: 'tool_started', tool_name: 'write' },
      {
        ts: '2026-08-12T17:38:53.431Z',
        type: 'tool_completed',
        tool_name: 'write',
        duration_ms: 3,
        outcome: 'error',
        tool_call_id: 'call-1',
      },
      { ts: '2026-08-12T17:49:25.683Z', type: 'turn_ended', outcome: 'error' },
    ]),
  );
  await fs.writeFile(
    path.join(dir, 'rewind_points.jsonl'),
    jsonl([{ prompt_index: 0, created_at: '2026-08-12T17:38:37.645Z' }]),
  );

  const stat = await fs.stat(path.join(dir, 'chat_history.jsonl'));
  const candidate = {
    id: '019ff70d-f3a1-7a92-bd32-f7fe40f198fe',
    path: path.join(dir, 'chat_history.jsonl'),
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };

  assert.equal(grokAdapter.workspaceOf!(candidate), canonicalizePath('/tmp/ws'));
  const ref = await grokAdapter.scanRef(candidate);
  assert.equal(ref.title, '整理索引');
  assert.equal(ref.updatedAt, '2026-08-12T17:49:25.712891Z');

  const session = await grokAdapter.parse(candidate);
  assert.deepEqual(
    session.turns.map((turn) => turn.kind),
    ['user', 'thinking', 'assistant', 'tool_call', 'tool_result', 'tool_result'],
  );
  // The ambient `<user_info>` block is boilerplate; the prompt is the query.
  assert.equal(session.turns[0]!.text, '整理 202503');
  assert.equal(session.turns[0]!.timestamp, '2026-08-12T17:38:37.645Z');
  assert.equal(session.stats.extras['injected:system_reminder'], 1);
  // Outcome lives in the event log, never on the result itself.
  const result = session.turns[4]!;
  assert.equal(result.isError, true);
  assert.equal(result.timestamp, '2026-08-12T17:38:53.431Z');
  assert.equal(result.durationMs, 3);
  assert.equal(session.turns[3]!.timestamp, '2026-08-12T17:38:53.428Z');
  // A turn that ended badly still ended; how it ended is its own fact.
  assert.deepEqual(session.stats.turnBoundaries.map((boundary) => boundary.completed), [true]);
  assert.equal(session.stats.extras['turn:error'], 1);
  // The receipt is the only completion proof a background task ever gets.
  assert.deepEqual(session.stats.backgroundTasks, [
    { id: 'call-9', title: 'sleep 1', finished: true },
  ]);
  assert.deepEqual(session.stats.branches, ['main']);
  assert.deepEqual(session.stats.models, ['grok-4.6', 'grok-4.6-build']);
  await fs.rm(home, { recursive: true, force: true });
});

/** Every adapter must produce well-formed turns from the newest real session. */
for (const adapter of [
  antigravityAdapter,
  claudeAdapter,
  codexAdapter,
  dshAdapter,
  grokAdapter,
] as ProviderAdapter[]) {
  test(`${adapter.provider}: parses the newest local session`, async (t) => {
    const candidates = await adapter.listCandidates();
    if (!candidates.length) return t.skip(`no local ${adapter.provider} sessions`);

    // A session can be opened and abandoned before anyone says anything, so
    // "the newest one" is the newest that actually holds a conversation.
    let session: NormalizedSession | undefined;
    let newest: SessionCandidate | undefined;
    for (const candidate of candidates.slice(0, 10)) {
      const parsed = await adapter.parse(candidate);
      if (!parsed.turns.length) continue;
      session = parsed;
      newest = candidate;
      break;
    }
    if (!session || !newest) return t.skip(`no ${adapter.provider} session with any turns`);

    const ref = await adapter.scanRef(newest);
    assert.equal(ref.provider, adapter.provider);
    assert.equal(ref.id, newest.id);
    assert.ok(path.isAbsolute(ref.path));
    const ids = new Set<string>();
    session.turns.forEach((turn, index) => {
      assert.equal(turn.index, index, 'turns must stay in file order');
      assert.ok(VALID_KINDS.has(turn.kind), `unexpected kind ${turn.kind}`);
      assert.ok(!ids.has(turn.id), 'turn ids must be unique');
      ids.add(turn.id);
      if (turn.kind === 'tool_call') assert.ok(turn.toolName, 'tool calls carry a name');
    });
    if (session.ref.workspace) assert.ok(path.isAbsolute(session.ref.workspace));
  });
}

test('listRecentSessions returns newest-first refs across providers', async (t) => {
  const refs = await listRecentSessions({ limit: 5 });
  if (!refs.length) return t.skip('no local sessions');
  assert.ok(refs.length <= 5);
  const times = refs.map((ref) => Date.parse(ref.updatedAt ?? ''));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('workspaceFromTrajectoryBlob reads the folder Antigravity opened', () => {
  // field 1 { field 1: "file:///tmp/a b", field 4: "master" }
  const uri = Buffer.from('file:///tmp/a%20b', 'utf8');
  const branch = Buffer.from('master', 'utf8');
  const opened = Buffer.concat([
    Buffer.from([0x0a, uri.length]), uri,
    Buffer.from([0x22, branch.length]), branch,
  ]);
  const blob = Buffer.concat([Buffer.from([0x0a, opened.length]), opened]);
  assert.equal(workspaceFromTrajectoryBlob(blob), canonicalizePath('/tmp/a b'));

  // An `outside-of-project` session carries no field 1 — only later fields.
  const id = Buffer.from('outside-of-project', 'utf8');
  const chatOnly = Buffer.concat([Buffer.from([0x92, 0x01, id.length]), id]);
  assert.equal(workspaceFromTrajectoryBlob(chatOnly), undefined);
});

test('a workspace filter covers the whole subtree, and / filters nothing', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref?.workspace) return t.skip('no local sessions with a known workspace');

  // The session lives *under* its parent directory, never equal to it.
  const parent = path.dirname(ref.workspace);
  const inParent = await listRecentSessions({ limit: 200, workspace: parent });
  assert.ok(inParent.some((item) => item.id === ref.id), 'subtree listing must contain the child');
  for (const item of inParent) assert.ok(item.workspace && isInside(parent, item.workspace));

  const root = await listRecentSessions({ limit: 5, workspace: '/' });
  const unfiltered = await listRecentSessions({ limit: 5 });
  assert.deepEqual(root.map((item) => item.id), unfiltered.map((item) => item.id));
});

test('resolveSession finds a session by id prefix', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const resolved = await resolveSession(ref.id.slice(0, 8));
  assert.ok(resolved, 'prefix lookup should resolve');
  assert.equal(resolved.ref.id, ref.id);
});

test('distillSession summarizes a real session', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const resolved = await resolveSession(ref.id);
  assert.ok(resolved);
  const digest = distillSession(await resolved.adapter.parse(resolved.candidate), { focus: 'review' });
  assert.equal(digest.session.id, ref.id);
  assert.ok(digest.markdown.includes('## 目标'));
  assert.ok(digest.markdown.includes('## 改动的文件'));
  for (const file of digest.touchedFiles) assert.ok(!file.includes('file://'));
});

test('aggregateWorkspaceSessions interleaves agents for one workspace', async (t) => {
  const repo = canonicalizePath(path.resolve(import.meta.dirname, '..', '..', '..'));
  const digest = await aggregateWorkspaceSessions(repo, { limit: 4 });
  if (!digest.sessions.length) return t.skip(`no sessions recorded for ${repo}`);

  assert.equal(digest.workspace, repo);
  for (const session of digest.sessions) {
    assert.ok(session.workspace && isInside(repo, session.workspace));
  }
  assert.deepEqual(
    digest.collaboratingAgents,
    [...new Set(digest.sessions.map((s) => s.provider))],
  );
  const stamps = digest.unifiedTimeline.map((entry) => Date.parse(entry.timestamp ?? ''));
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), 'timeline must be chronological');
  for (const touches of Object.values(digest.fileAttribution)) {
    assert.ok(touches.length > 0);
    for (const touch of touches) assert.ok(digest.sessions.some((s) => s.id === touch.sessionId));
  }
  assert.ok(digest.markdown.includes('跨智能体协作纪实'));
});

test('searchSessions rejects an empty query', async () => {
  await assert.rejects(() => searchSessions('   '), /must not be empty/);
});

test('searchSessions finds a literal taken from a real session', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const resolved = await resolveSession(ref.id);
  assert.ok(resolved);
  const session = await resolved.adapter.parse(resolved.candidate);
  const needle = session.turns
    .find((turn) => (turn.text ?? '').trim().length > 20)
    ?.text?.replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  if (!needle) return t.skip('no textual turn to search for');

  const hits = await searchSessions(needle, { provider: ref.provider, limit: 5 });
  const hit = hits.find((candidate) => candidate.session.id === ref.id);
  assert.ok(hit, `expected ${ref.id} among ${hits.length} hits`);
  assert.ok(hit.totalMatches >= 1);
  assert.ok(hit.matches.length <= hit.totalMatches);
  assert.ok(hit.matches.every((match) => match.excerpt.length > 0));
});

test('every search hit carries the turn that `turn --event` wants', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const resolved = await resolveSession(ref.id);
  assert.ok(resolved);
  const session = await resolved.adapter.parse(resolved.candidate);
  const ranges = summarizeTurns(session).map((turn) => turn.events);
  if (!ranges.length) return t.skip('session has no turns');

  const hits = await searchSessions('.', {
    regex: true,
    provider: ref.provider,
    limit: 5,
    maxPerSession: 5,
  });
  const hit = hits.find((candidate) => candidate.session.id === ref.id);
  if (!hit?.matches.length) return t.skip('no matches in the newest session');

  for (const match of hit.matches) {
    const range = ranges[match.turn - 1];
    assert.ok(range, `T${match.turn} is not a turn of the session`);
    assert.ok(
      match.index >= range[0] && match.index <= range[1],
      `E${match.index} claims T${match.turn}, whose events are ${range[0]}–${range[1]}`,
    );
    // The handle has to survive the round trip it exists to enable.
    assert.deepEqual(turnDetail(session, match.turn).summary.events, range);
  }
});

test('the index and the parsing path agree on the turn a hit belongs to', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const options = { provider: ref.provider, limit: 3, maxPerSession: 3 } as const;
  const indexed = await searchSessions('.', { ...options, regex: true });
  const parsed = await searchSessions('.', { ...options, regex: true, useIndex: false });
  const handles = (hits: Awaited<ReturnType<typeof searchSessions>>) =>
    hits.map((hit) => [hit.session.id, hit.matches.map((match) => `T${match.turn}·E${match.index}`)]);
  if (!indexed.length || !parsed.length) return t.skip('no matches to compare');
  assert.deepEqual(handles(indexed), handles(parsed));
});

/** One matched event, as the matcher sees it. */
const candidate = (over: Partial<Candidate> & Pick<Candidate, 'index' | 'kind'>): Candidate => ({
  body: '',
  ...over,
});

test('the folder hides this search running, and nothing a past session did', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  const justNow = new Date(now - 4_000).toISOString();
  const lastWeek = '2026-09-07T12:00:00Z';
  const fold = echoFolder(now);

  const invocation = candidate({
    index: 10,
    kind: 'tool_call',
    timestamp: justNow,
    body: '{"command":"1session search \\"NPM_TOKEN\\" --global"}',
  });
  assert.ok(fold(invocation), 'the invocation writing itself down is not a finding');
  assert.ok(fold(candidate({ index: 11, kind: 'tool_result', timestamp: justNow, body: 'NPM_TOKEN …' })),
    'neither is what it printed');
  assert.ok(!fold(candidate({ index: 40, kind: 'tool_result', timestamp: justNow, body: 'NPM_TOKEN …' })),
    'a result far from the invocation is somebody else’s output');

  // The window is the whole guarantee that history is never touched.
  const old = echoFolder(now);
  assert.ok(
    !old(candidate({ ...invocation, timestamp: lastWeek })),
    'a session that ran the same command last week is a real hit',
  );
  assert.ok(
    !old(candidate({ index: 10, kind: 'tool_call', body: '1session search x' })),
    'an undated event cannot be proven to be happening now',
  );
  assert.ok(
    !echoFolder(now)(candidate({ index: 10, kind: 'tool_call', timestamp: justNow, body: 'npm run build' })),
    'a shell call that is not 1session is ordinary work',
  );
});

test('isCallerSession accepts every spelling of a session id', () => {
  const ref = { id: '3ab9fe0e-ab9c-4412-bf3b-e041d82e654e', provider: 'claude', path: '/x' } as const;
  assert.ok(isCallerSession(ref, '3ab9fe0e-ab9c-4412-bf3b-e041d82e654e'));
  assert.ok(isCallerSession(ref, 'claude:3ab9fe0e-ab9c-4412-bf3b-e041d82e654e'));
  assert.ok(isCallerSession(ref, '3ab9fe0e'), 'the 8-char prefix `list` prints');
  assert.ok(!isCallerSession(ref, '3ab9f'), 'too short to be unique, as resolveSession also holds');
  assert.ok(!isCallerSession(ref, 'deadbeef'));
  assert.ok(!isCallerSession(ref, undefined));
  assert.ok(!isCallerSession(ref, '  '));
});

test('searchSessions honours the kind filter and regex mode', async (t) => {
  const hits = await searchSessions('.', { regex: true, kinds: ['tool_call'], limit: 3, maxPerSession: 3 });
  if (!hits.length) return t.skip('no local sessions with tool calls');
  for (const hit of hits) {
    for (const match of hit.matches) {
      assert.equal(match.kind, 'tool_call');
      assert.ok(match.toolName, 'tool call matches carry a tool name');
    }
  }
});

const shellTurn = (command: string): TurnEvent => ({
  id: 't',
  index: 0,
  kind: 'tool_call',
  toolName: 'run_command',
  toolArgs: { CommandLine: command },
});

test('fileWrites picks up writes made through the shell', () => {
  const paths = (command: string) =>
    fileWrites(shellTurn(command)).map((write) => resolveWritePath(write, '/ws'));

  assert.deepEqual(paths('echo hi > /tmp/out.txt'), ['/tmp/out.txt']);
  assert.deepEqual(paths('cmd 2>&1 | tee -a /var/log/run.log'), ['/var/log/run.log']);
  assert.deepEqual(paths('sed -i.bak "s/a/b/" docs/README.md'), ['/ws/docs/README.md']);
  assert.deepEqual(paths("python3 -c \"Path('/tmp/x.json').write_text(s)\""), ['/tmp/x.json']);
});

test('fileWrites ignores devices, descriptors and directory creation', () => {
  for (const command of [
    'ls -la 2>/dev/null || true',
    'rg --files > /dev/null',
    'cmd 2>&1 | grep x',
    'mkdir -p /tmp/d && touch /tmp/d/x',
  ]) {
    assert.deepEqual(fileWrites(shellTurn(command)), [], `should not report a write: ${command}`);
  }
});

test('fileWrites attributes remote writes to the ssh host, in the right direction', () => {
  const one = (command: string) => {
    const writes = fileWrites(shellTurn(command));
    assert.equal(writes.length, 1, command);
    return writes[0]!;
  };

  const inSsh = one("ssh admin@1.2.3.4 'echo x > /home/admin/f'");
  assert.equal(inSsh.host, '1.2.3.4');
  assert.equal(resolveWritePath(inSsh, '/ws'), '1.2.3.4:/home/admin/f');

  // `scp remote:src local_dst` lands locally — the host on the line is the source.
  const pulled = one('scp admin@1.2.3.4:/home/admin/out.png /tmp/local.png');
  assert.equal(pulled.host, undefined);
  assert.equal(resolveWritePath(pulled, '/ws'), '/tmp/local.png');

  const pushed = one('scp local.sh admin@1.2.3.4:/home/admin/');
  assert.equal(pushed.host, '1.2.3.4');
});

test('buildOverview reports session-level stats from a real session', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const resolved = await resolveSession(ref.id);
  assert.ok(resolved);
  const session = await resolved.adapter.parse(resolved.candidate);
  const overview = buildOverview(session);

  assert.equal(overview.session.id, ref.id);
  assert.ok(overview.markdown.includes('## 末态（最后发生的事实）'));
  assert.ok(overview.markdown.includes('## 统计'));
  assert.ok(overview.markdown.includes('### 项目文件'));
  // The semantic layer must stay explicitly absent, not faked.
  assert.ok(overview.markdown.includes('属语义层，本阶段不生成'));
  assert.equal(
    overview.stats.events.tool_call,
    session.turns.filter((turn) => turn.kind === 'tool_call').length,
  );
  assert.ok(overview.stats.turns > 0);
  const { observed, derived, candidate } = overview.stats.filesByProvenance;
  assert.equal(observed + derived + candidate, overview.stats.filesChanged, 'provenance must cover every row');
  assert.equal(candidate, 0, 'a candidate path is never a changed file');
});

test('classifyUserTurn separates corrections from nudges and pasted reports', () => {
  assert.equal(classifyUserTurn('继续'), 'nudge');
  assert.equal(classifyUserTurn('continue'), 'nudge');
  assert.equal(classifyUserTurn('这个描述不对，应该改成 MiniMax-H3'), 'correction');
  // Short instructions are real work, not filler.
  assert.equal(classifyUserTurn('检查一下进度'), 'correction');
  assert.equal(classifyUserTurn(`### 🎉 阶段性重大进展\n${'详细报告内容。'.repeat(60)}`), 'paste');
});

test('summarizeTurns splits a session on user messages and covers every event', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const resolved = await resolveSession(ref.id);
  assert.ok(resolved);
  const session = await resolved.adapter.parse(resolved.candidate);
  const summaries = summarizeTurns(session);
  if (!summaries.length) return t.skip('session has no turns');

  assert.equal(summaries[0]!.events[0], 0, 'the first turn starts at the first event');
  assert.equal(summaries.at(-1)!.events[1], session.turns.length - 1, 'the last turn ends at the last event');
  for (let i = 1; i < summaries.length; i++) {
    assert.equal(summaries[i]!.events[0], summaries[i - 1]!.events[1] + 1, 'turns must tile without gaps');
  }
  const detail = turnDetail(session, 1);
  assert.equal(detail.events.length, summaries[0]!.eventCount);
});

test('turn boundaries are one rule, whether the indices come from SQL or a parse', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const resolved = await resolveSession(ref.id);
  assert.ok(resolved);
  const session = await resolved.adapter.parse(resolved.candidate);
  const starts = turnStarts(session);
  const fromIndices = turnStartsFrom(
    session.turns.filter((turn) => turn.kind === 'user' && turn.text?.trim()).map((turn) => turn.index),
    session.turns.length,
  );
  assert.deepEqual(starts, fromIndices);
  assert.deepEqual(
    starts,
    summarizeTurns(session).map((turn) => turn.events[0]),
    'turn starts must be the starts `turns` prints',
  );
  for (const [no, start] of starts.entries()) {
    assert.equal(turnNoAt(starts, start), no + 1, 'a turn contains its own first event');
  }
});

test('turnStartsFrom holds up on the shapes a real session never shows', () => {
  assert.deepEqual(turnStartsFrom([], 0), [], 'an empty session has no turns');
  assert.deepEqual(turnStartsFrom([], 9), [0], 'events with no user message are all turn 1');
  // Provider preamble before the first prompt belongs to turn 1, not to turn 0.
  assert.deepEqual(turnStartsFrom([4, 20], 30), [0, 20]);
  assert.equal(turnNoAt([0, 20], 19), 1);
  assert.equal(turnNoAt([0, 20], 20), 2);
  assert.equal(turnNoAt([0, 20], -1), 0, 'an index before every turn belongs to none');
});

test('parseEventSpec accepts a value, a range and a list', () => {
  assert.deepEqual(parseEventSpec('214', 500), [214]);
  assert.deepEqual(parseEventSpec('214-218', 500), [214, 215, 216, 217, 218]);
  assert.deepEqual(parseEventSpec('218-214', 500), [214, 215, 216, 217, 218], 'reversed is the same span');
  assert.deepEqual(parseEventSpec('214,216, 214', 500), [214, 216], 'duplicates collapse, order is ascending');
  assert.deepEqual(parseEventSpec('3-5,9', 500), [3, 4, 5, 9]);
  // A range may overshoot the end — a bare index may not, so it still errors
  // naming the number that was typed.
  assert.deepEqual(parseEventSpec('8-99', 10), [8, 9]);
  assert.deepEqual(parseEventSpec('40', 10), [40]);
  assert.throws(() => parseEventSpec('44a', 500), /无法解析/);
  assert.throws(() => parseEventSpec('900-999', 10), /不含该会话的任何事件/);
  assert.throws(() => parseEventSpec('0-400', 500), /超过上限/);
});

test('eventDetail recovers antigravity output that the transcript truncated', async (t) => {
  const refs = await listRecentSessions({ limit: 8, provider: 'antigravity' });
  for (const ref of refs) {
    const resolved = await resolveSession(ref.id);
    if (!resolved) continue;
    const session = await resolved.adapter.parse(resolved.candidate);
    const cut = session.turns.find((turn) => turn.truncated && turn.sourceIndex !== undefined);
    if (!cut) continue;

    const detail = await eventDetail(session, cut.index);
    assert.ok(detail.fullText || detail.truncationNote, 'a truncated event must resolve or say why not');
    if (detail.fullText) {
      assert.ok(
        detail.fullText.length >= (cut.toolResult ?? cut.text ?? '').length,
        'the recovered copy must not be shorter than the transcript one',
      );
    }
    return;
  }
  t.skip('no truncated antigravity events available');
});

type LocalProvider = 'codex' | 'antigravity' | 'claude' | 'dsh' | 'grok';

const ALL_PROVIDERS: readonly LocalProvider[] = ['codex', 'antigravity', 'claude', 'dsh', 'grok'];

async function newestOf(provider: LocalProvider) {
  const [ref] = await listRecentSessions({ limit: 1, provider });
  if (!ref) return undefined;
  const resolved = await resolveSession(ref.id);
  return resolved ? resolved.adapter.parse(resolved.candidate) : undefined;
}

test('commandLedger uses the provider ledger when codex records one', async (t) => {
  const session = await newestOf('codex');
  if (!session) return t.skip('no local codex sessions');
  const commands = commandLedger(session);
  if (!commands.length) return t.skip('session ran no commands');

  assert.ok(commands.every((record) => record.provenance === 'observed'));
  assert.ok(commands.every((record) => record.extractor === 'item:CommandExecution'));
  assert.equal(commands.length, session.stats.commands.length);
  // exit codes come from the provider, never from guessing at output text
  assert.ok(commands.some((record) => record.exitCode !== undefined));
  for (const record of commands) {
    if (record.pid !== undefined) assert.match(record.pid, /^\d+$/);
  }
});

test('antigravity command records take exit codes from the printed status only', async (t) => {
  const session = await newestOf('antigravity');
  if (!session) return t.skip('no local antigravity sessions');
  const commands = commandLedger(session);
  if (!commands.length) return t.skip('session ran no commands');

  assert.ok(commands.every((record) => record.provenance === 'derived'));
  // A result without a printed status must not be reported as a success.
  const results = session.turns.filter((turn) => turn.kind === 'tool_result');
  const printed = results.filter((turn) => /The command exited with code/.test(turn.toolResult ?? ''));
  const withCode = results.filter((turn) => turn.exitCode !== undefined);
  assert.equal(withCode.length, printed.length, 'exit codes must never be invented');
});

test('errorLedger only reports failures, and flags later success deterministically', async (t) => {
  const session = await newestOf('codex');
  if (!session) return t.skip('no local codex sessions');
  const errors = errorLedger(session);
  if (!errors.length) return t.skip('session had no failures');
  for (const record of errors) {
    assert.ok((record.exitCode ?? 0) !== 0 || record.stderr, 'an error must have a non-zero exit or stderr');
    assert.equal(typeof record.laterSucceeded, 'boolean');
  }
});

test('jobLedger never claims a status it cannot evidence', async (t) => {
  const session = await newestOf('codex');
  if (!session) return t.skip('no local codex sessions');
  const jobs = jobLedger(session);
  if (!jobs.length) return t.skip('session started no background jobs');
  for (const job of jobs) {
    assert.ok(job.evidence.length > 0, 'every job must say why it has its status');
    // Seeing a launch is not proof a job is alive.
    if (job.status === 'running') {
      assert.ok(job.evidence.some((line) => /pid|ps |仍在/.test(line)));
    }
  }
});

test('fileLedger separates project files from runtime and log noise', async (t) => {
  const session = await newestOf('antigravity');
  if (!session) return t.skip('no local antigravity sessions');
  const files = fileLedger(session);
  if (!files.length) return t.skip('session wrote no files');

  for (const record of files) {
    assert.ok(record.extractor.length > 0, 'every file record must name its extractor');
    assert.notEqual(record.provenance, 'candidate', 'files are never mere mentions');
    if (record.group === 'project') {
      assert.ok(!record.host, 'a remote file is never a project file');
      assert.ok(!/\.log$/.test(record.path), 'logs belong to the log group');
      assert.ok(session.ref.workspace && record.path.startsWith(session.ref.workspace));
    }
    if (record.host) assert.equal(record.group === 'project', false);
  }
});

test('turn status is evidence-backed and never invented', async (t) => {
  const session = await newestOf('codex');
  if (!session) return t.skip('no local codex sessions');
  const summaries = summarizeTurns(session);

  for (const turn of summaries) {
    if (turn.status === 'completed') continue;
    assert.ok(turn.evidence.length > 0, `T${turn.no} claims ${turn.status} with no evidence`);
  }
  // Unfinished turns must match the provider's own unpaired task_started records.
  const declaredOpen = session.stats.turnBoundaries.filter((boundary) => !boundary.completed).length;
  if (declaredOpen) {
    assert.equal(summaries.filter((turn) => turn.status === 'unfinished').length, declaredOpen);
  }
  for (const turn of summaries) {
    if (turn.nudgeCount > 0) {
      assert.ok(turn.evidence.some((line) => line.includes('推进指令')));
    }
  }
});

test('stripHeredocs keeps the command but drops the payload being written', () => {
  const command = "cat > src/x.ts <<'EOF'\nconst f = (a) => a.kind;\nEOF";
  const stripped = stripHeredocs(command);
  assert.match(stripped, /cat > src\/x\.ts/);
  assert.doesNotMatch(stripped, /a\.kind/);
});

test('source code written through a here-doc never becomes a fact', () => {
  const turn = (command: string): TurnEvent => ({
    id: 't',
    index: 0,
    kind: 'tool_call',
    toolName: 'Bash',
    toolArgs: { command },
  });
  const paths = (command: string) => fileWrites(turn(command)).map((write) => write.path);

  // Arrow functions are code, not redirects.
  assert.deepEqual(paths('const f = (a, b) => b[1].length;'), []);
  // Property access is not a file, however much it looks like one.
  assert.deepEqual(paths('cp r.source a.name'), []);
  // Only the real redirect survives a here-doc full of source code.
  const written = fileWrites(
    turn("cat > src/x.ts <<'EOF'\nconst g = (x) => x.kind;\nssh admin@1.2.3.4 'echo hi'\nEOF"),
  );
  assert.deepEqual(written.map((write) => write.path), ['src/x.ts']);
  // A host mentioned inside the payload must not be attributed to the write.
  assert.equal(written[0]!.host, undefined);
});

test('token usage separates cache replays from real input', async (t) => {
  const session = await newestOf('claude');
  if (!session?.stats.tokens) return t.skip('no claude session with usage');
  const { input, output, cacheRead } = session.stats.tokens;
  assert.ok(input > 0 && output > 0);
  // A 200k-context session cannot have tens of millions of input tokens.
  assert.ok(input < 10_000_000, `input ${input} looks like cache reads counted as input`);
  if (cacheRead !== undefined) assert.ok(cacheRead >= 0);
});

test('the file ledger has one row count, whichever way you ask', async (t) => {
  for (const provider of ALL_PROVIDERS) {
    const session = await newestOf(provider);
    if (!session) continue;
    const files = fileLedger(session);
    const overview = buildOverview(session);

    // Groups tile the ledger: every row belongs to exactly one of them.
    const grouped = (['project', 'runtime', 'log'] as const).reduce(
      (total, group) => total + files.filter((file) => file.group === group).length,
      0,
    );
    assert.equal(grouped, files.length, `${provider}: groups must cover every row`);
    assert.equal(overview.stats.filesChanged, files.length, `${provider}: overview disagrees with the ledger`);
    assert.equal(overview.writes.length, files.length, `${provider}: overview rows disagree with the ledger`);
    // Actions are counted per write, so they can exceed distinct files but never fall short.
    assert.ok(overview.stats.fileChangeEvents >= files.length, `${provider}: fewer actions than files`);
  }
  t.diagnostic('file counts agree across overview, ledger and groups');
});

test('stats.errors matches the error ledger exactly', async (t) => {
  for (const provider of ALL_PROVIDERS) {
    const session = await newestOf(provider);
    if (!session) continue;
    const overview = buildOverview(session);
    assert.equal(overview.stats.errors, errorLedger(session).length, `${provider} error counts disagree`);
    assert.equal(overview.stats.commands, commandLedger(session).length, `${provider} command counts disagree`);
  }
  t.diagnostic('checked every provider with a local session');
});

test('provenance is assigned by rule, never by guess', async (t) => {
  const session = await newestOf('claude');
  if (!session) return t.skip('no local claude sessions');

  // Files come from actions only; anchors are the place for mentions.
  for (const record of fileLedger(session)) {
    assert.ok(['observed', 'derived'].includes(record.provenance));
    if (record.provenance === 'observed') assert.match(record.extractor, /^(tool|patch|item):/);
    if (record.provenance === 'derived') assert.match(record.extractor, /^shell:/);
  }
  const overview = buildOverview(session);
  for (const anchor of overview.anchors.paths) {
    assert.equal(anchor.provenance, 'candidate', 'a path seen in text is only a candidate');
  }
  for (const job of jobLedger(session)) {
    assert.ok(['observed', 'derived'].includes(job.provenance));
    assert.ok(job.extractor.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Index store
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import { openStore, resetStoreCache } from '../src/store/db.js';
import { indexSession } from '../src/store/indexer.js';
import { invocationsOf, deriveEdges, edgesOf } from '../src/store/edges.js';
import { readSession, sessionRow } from '../src/store/read.js';

async function tempStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-index-'));
  resetStoreCache();
  const db = await openStore(path.join(dir, 'index.db'));
  return { db, dir };
}

test('a session read back from the index equals a fresh parse', async (t) => {
  const { db, dir } = await tempStore();
  try {
    let checked = 0;
    for (const provider of ALL_PROVIDERS) {
      // An abandoned session round-trips trivially; take one with content.
      const refs = await listRecentSessions({ limit: 10, provider });
      let handle: Awaited<ReturnType<typeof resolveSession>>;
      let direct: NormalizedSession | undefined;
      for (const ref of refs) {
        const resolved = await resolveSession(ref.id);
        if (!resolved) continue;
        const parsed = await resolved.adapter.parse(resolved.candidate);
        if (!parsed.turns.length) continue;
        handle = resolved;
        direct = parsed;
        break;
      }
      if (!handle || !direct) continue;
      const { id } = await indexSession(db, handle);
      const row = sessionRow(db, id)!;
      // This is the safety net for the whole store: if these ever diverge,
      // the index is rewriting facts rather than caching them.
      assert.deepStrictEqual(readSession(db, row), direct, `${provider} round-trip`);
      assert.equal(
        buildOverview(readSession(db, row)).markdown,
        buildOverview(direct).markdown,
        `${provider} renders differently through the index`,
      );
      checked++;
    }
    if (!checked) return t.skip('no local sessions');
    t.diagnostic(`round-tripped ${checked} provider(s)`);
  } finally {
    resetStoreCache();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an unchanged fingerprint costs no re-read, --force does', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const handle = await resolveSession(ref.id);
  if (!handle) return t.skip('unresolvable');
  const { db, dir } = await tempStore();
  try {
    assert.equal((await indexSession(db, handle)).action, 'indexed');
    assert.equal((await indexSession(db, handle)).action, 'reused');
    assert.equal((await indexSession(db, handle, { force: true })).action, 'indexed');
  } finally {
    resetStoreCache();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a new extractor version re-derives facts from stored events', async (t) => {
  const [ref] = await listRecentSessions({ limit: 1 });
  if (!ref) return t.skip('no local sessions');
  const handle = await resolveSession(ref.id);
  if (!handle) return t.skip('unresolvable');
  const { db, dir } = await tempStore();
  try {
    const { id, session } = await indexSession(db, handle);
    db.prepare('UPDATE sessions SET extractor_version = -1 WHERE id = ?').run(id);
    // The source file is left alone on purpose: only the derived layer is stale.
    assert.equal((await indexSession(db, handle)).action, 'facts-rederived');
    const rows = db.prepare('SELECT count(*) AS c FROM file_ops WHERE session_id = ?').get(id) as {
      c: number;
    };
    assert.equal(rows.c, fileLedger(session).length);
  } finally {
    resetStoreCache();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('here-doc payloads never become edges', () => {
  const quoted: TurnEvent = {
    id: 'x#0',
    index: 0,
    kind: 'tool_call',
    toolName: 'Bash',
    toolArgs: {
      command: "cat > README.md <<'EOF'\n1session overview 3ab9fe0e\n1session handoff 01a0907c\nEOF",
    },
  };
  assert.deepEqual(invocationsOf(quoted), []);

  const real: TurnEvent = {
    id: 'x#1',
    index: 1,
    kind: 'tool_call',
    toolName: 'Bash',
    toolArgs: { command: 'node dist/bin/1session.js overview 3ab9fe0e | head -5' },
  };
  const found = invocationsOf(real);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.relation, 'references');
  assert.equal(found[0]!.target, '3ab9fe0e');
});

test('verbs without a session target produce no edge', () => {
  for (const command of ['1session list --limit 10', '1session search deployment --since 7d']) {
    const event: TurnEvent = {
      id: 'x#0',
      index: 0,
      kind: 'tool_call',
      toolName: 'Bash',
      toolArgs: { command },
    };
    assert.deepEqual(invocationsOf(event), [], command);
  }
});

test('re-deriving edges does not inflate the evidence count', async (t) => {
  const { db, dir } = await tempStore();
  try {
    const [target] = await listRecentSessions({ limit: 1, provider: 'codex' });
    const [caller] = await listRecentSessions({ limit: 1, provider: 'claude' });
    if (!target || !caller) return t.skip('needs a codex and a claude session');
    for (const ref of [target, caller]) {
      const handle = await resolveSession(ref.id);
      if (handle) await indexSession(db, handle, { edges: false });
    }
    const callerId = `claude:${caller.id}`;
    const session = readSession(db, sessionRow(db, callerId)!);
    const synthetic: NormalizedSession = {
      ...session,
      turns: [
        {
          id: `${caller.id}#0`,
          index: 0,
          kind: 'tool_call',
          toolName: 'Bash',
          toolArgs: { command: `1session overview ${target.id}` },
        },
      ],
    };
    deriveEdges(db, callerId, synthetic);
    const first = edgesOf(db, callerId);
    deriveEdges(db, callerId, synthetic);
    const second = edgesOf(db, callerId);
    assert.equal(first.length, 1);
    assert.deepEqual(
      second.map((edge) => edge.evidenceCount),
      first.map((edge) => edge.evidenceCount),
    );
  } finally {
    resetStoreCache();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Search query layer
// ---------------------------------------------------------------------------

import { mandatoryLiteral, planQuery } from '../src/search.js';

test('mandatoryLiteral only claims substrings every match must contain', () => {
  assert.equal(mandatoryLiteral('src/ledger\\.ts'), 'src/ledger.ts');
  assert.equal(mandatoryLiteral('src/.*ledger'), 'ledger');
  assert.equal(mandatoryLiteral('sess+ion_read'), 'ion_read');
  assert.equal(mandatoryLiteral('ledger[._]ts'), 'ledger');

  // Anything optional must not be claimed: `c` can be absent from a match.
  assert.equal(mandatoryLiteral('abc?def'), 'def');
  assert.equal(mandatoryLiteral('abc*def'), 'def');
  assert.equal(mandatoryLiteral('abc{0,2}def'), 'def');

  // Alternation and groups make nothing provably mandatory — give up instead
  // of guessing, or the prefilter starts hiding rows.
  assert.equal(mandatoryLiteral('(foo|bar)baz'), undefined);
  assert.equal(mandatoryLiteral('foo|bar'), undefined);
  assert.equal(mandatoryLiteral('(abc)?def'), undefined);
  assert.equal(mandatoryLiteral('\\d+\\.\\d+'), undefined);
});

test('planQuery folds case only where SQLite and the matcher agree', () => {
  // `gi` without `u` folds ASCII only, which is exactly what SQLite lower() does.
  assert.deepEqual(planQuery('Deploy'), { literal: 'deploy', fold: true });
  assert.deepEqual(planQuery('Deploy', { caseSensitive: true }), { literal: 'Deploy' });
  // CJK has no case, so it is compared verbatim on both sides.
  assert.deepEqual(planQuery('会话'), { literal: '会话' });
  // Mixed: keep the caseless run, never a folded non-ASCII string.
  assert.deepEqual(planQuery('会话Deploy'), { literal: '会话' });
  // Too short or newline-spanning literals cannot prefilter safely.
  assert.deepEqual(planQuery('x'), {});
  assert.deepEqual(planQuery('a\nb'), {});
});

test('indexed search and --no-index agree hit for hit', async (t) => {
  const shapes: [string, Record<string, unknown>][] = [
    ['session', { limit: 20 }],
    ['会话', { limit: 20 }],
    ['ledger\\.(ts)', { regex: true, limit: 20 }],
    ['(ledger|resolver)\\.ts', { regex: true, limit: 20 }],
  ];
  let compared = 0;
  for (const [query, options] of shapes) {
    const indexed = await searchSessions(query, { ...options, since: '30d' });
    const direct = await searchSessions(query, { ...options, since: '30d', useIndex: false });
    if (!indexed.length && !direct.length) continue;
    const shape = (hits: Awaited<ReturnType<typeof searchSessions>>) =>
      hits.map((hit) => ({
        id: hit.session.id,
        total: hit.totalMatches,
        matches: hit.matches.map((match) => `${match.index}|${match.kind}|${match.excerpt}`),
      }));
    // Same sessions, same counts, same excerpts, same order. The SQL layer is
    // allowed to narrow the candidates, never to change the answer.
    assert.deepEqual(shape(indexed), shape(direct), `query ${query} diverged`);
    compared++;
  }
  if (!compared) return t.skip('no local sessions matched');
  t.diagnostic(`compared ${compared} query shape(s)`);
});

test('skill install links into every agent, is idempotent and reversible', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), '1session-skill-'));
  for (const dir of ['.claude', '.codex', path.join('.gemini', 'antigravity'), '.grok', '.dsh']) {
    await fs.mkdir(path.join(home, dir), { recursive: true });
  }

  const first = await installSkill({ home });
  assert.deepEqual(
    first.map((row) => [row.agent, row.action]),
    [
      ['claude', 'linked'],
      ['codex', 'linked'],
      ['antigravity', 'linked'],
      ['grok', 'linked'],
      ['dsh', 'linked'],
    ],
  );
  // Every agent reads the same file through its own path.
  for (const row of skillStatus(home)) {
    assert.equal(row.state.kind, 'linked');
    const skill = await fs.readFile(path.join(row.entryPath, 'SKILL.md'), 'utf8');
    assert.match(skill, /^name: 1session$/m);
  }

  const again = await installSkill({ home });
  assert.deepEqual(new Set(again.map((row) => row.action)), new Set(['unchanged']));

  const removed = await uninstallSkill({ home });
  assert.deepEqual(new Set(removed.map((row) => row.action)), new Set(['removed']));
  assert.deepEqual(new Set(skillStatus(home).map((row) => row.state.kind)), new Set(['absent']));
  await fs.rm(home, { recursive: true, force: true });
});

test('skill install skips agents that are not installed, and can copy instead of link', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), '1session-skill-'));
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });

  const results = await installSkill({ home, mode: 'copy' });
  const byAgent = Object.fromEntries(results.map((row) => [row.agent, row.action]));
  assert.equal(byAgent.codex, 'copied');
  assert.equal(byAgent.claude, 'skipped');
  assert.equal(byAgent.antigravity, 'skipped');
  assert.equal(byAgent.grok, 'skipped');
  assert.equal(byAgent.dsh, 'skipped');

  const status = skillStatus(home).find((row) => row.agent === 'codex')!;
  assert.deepEqual(status.state, { kind: 'copied', current: true });
  // A copy that drifted from the package must not read as up to date.
  await fs.writeFile(path.join(status.entryPath, 'SKILL.md'), 'stale');
  assert.deepEqual(skillStatus(home).find((row) => row.agent === 'codex')!.state, {
    kind: 'copied',
    current: false,
  });
  await fs.rm(home, { recursive: true, force: true });
});

/* ---------- serve: DreamMate Network Service ---------- */

/** Boots the service on an ephemeral port so the tests never collide. */
async function withServer<T>(
  options: Parameters<typeof createServer>[0],
  body: (base: string) => Promise<T>,
): Promise<T> {
  const server = createServer(options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  try {
    return await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('sessionUri renders the network-wide address of a session', () => {
  assert.equal(sessionUri('mac', 'codex', '01a0907c'), 'session://mac/codex/01a0907c');
  assert.equal(sessionUri('iphone', 'yima', 'abc123'), 'session://iphone/yima/abc123');
});

test('buildManifest satisfies the dreammate-network node contract', async () => {
  const manifest = await buildManifest('http://scott-mac:7777');
  // Required by schemas/node.schema.json.
  assert.ok(manifest.node_id && manifest.name && manifest.type);
  assert.ok(Array.isArray(manifest.services) && manifest.services.length > 0);

  const service = manifest.services[0]!;
  assert.equal(service.id, 'session-registry');
  assert.equal(service.kind, 'session_registry');
  // The four capability names the design doc pins down, plus turns.
  for (const capability of ['sessions.list', 'sessions.read', 'sessions.search', 'sessions.graph']) {
    assert.ok(service.capabilities.includes(capability), `missing ${capability}`);
  }
  // Transport lives in `access`, never in the capability name itself. The host
  // is whatever the node advertises, so only the shape is fixed here.
  assert.ok((service.access?.length ?? 0) >= 1);
  for (const entry of service.access ?? []) {
    assert.equal(entry.protocol, 'http');
    assert.match(entry.base_url ?? '', /^http:\/\/.+\/v1$/);
  }
  // 有 tailnet 身份时给两条：MagicDNS 名在前，IP 兜底——调用方 DNS 被劫持时
  // 还有路可走。数组有序，靠前的优先。
  const identity = await sharedIdentity();
  if (identity.source === 'tailscale' && identity.ipv4) {
    assert.equal(service.access?.length, 2);
    assert.ok(service.access?.[0]!.base_url?.includes(identity.dnsName ?? ''));
    assert.ok(service.access?.[1]!.base_url?.includes(identity.ipv4));
  }
  assert.ok(!service.capabilities.some((name: string) => /http|mcp|cli/i.test(name)));
});

test('serve answers /health and /manifest, and does not pretend to be the node', async () => {
  await withServer({}, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, 'ok');

    const manifest = (await (await fetch(`${base}/manifest`)).json()) as { services: unknown[] };
    // 只报自己这一个 service；节点全貌在本机 agent 的 :36908/manifest。
    assert.equal(manifest.services.length, 1);

    // `node` 这个词属于 agent。一个 L2 服务暴露 /v1/node 会让人以为
    // 能从这儿拿到节点全貌，其实只有它自己。
    assert.equal((await fetch(`${base}/v1/node`)).status, 404);
  });
});

test('serve is read-only and reports unknown routes and bad queries honestly', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/manifest`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/v1/nope`)).status, 404);
    assert.equal((await fetch(`${base}/v1/search`)).status, 400);
    assert.equal((await fetch(`${base}/v1/sessions/definitely-not-a-session`)).status, 404);
  });
});

test('serve gates every route behind the token when one is set', async () => {
  await withServer({ token: 's3cret' }, async (base) => {
    assert.equal((await fetch(`${base}/manifest`)).status, 401);
    assert.equal(
      (await fetch(`${base}/manifest`, { headers: { authorization: 'Bearer wrong' } })).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/manifest`, { headers: { authorization: 'Bearer s3cret' } })).status,
      200,
    );
    // The health check is not a way around it either.
    assert.equal((await fetch(`${base}/health`)).status, 401);
  });
});

test('serve stamps a session:// uri onto every listed session', async () => {
  await withServer({}, async (base) => {
    const body = (await (await fetch(`${base}/v1/sessions?limit=3`)).json()) as {
      node: string;
      sessions: { id: string; provider: string; uri: string }[];
    };
    assert.ok(body.node);
    for (const session of body.sessions) {
      assert.equal(session.uri, `session://${body.node}/${session.provider}/${session.id}`);
    }
  });
});

/* ---------- Node 身份：tailscale 优先，本地回退 ---------- */


test('nodeIdentity 总能给出可用身份，有没有 tailscale 都一样', async () => {
  resetIdentityCache();
  const identity = await sharedIdentity();
  assert.ok(identity.node_id, '任何情况下都得有 node_id');
  assert.ok(identity.name, '任何情况下都得有 name');
  assert.ok(identity.type, '任何情况下都得有 type');
  assert.ok(['tailscale', 'local'].includes(identity.source));
  // tailnet 的名字必须唯一且可读，所以绝不能是 iOS 那个人人都叫的 localhost。
  if (identity.source === 'tailscale') {
    assert.ok(identity.dnsName, 'tailscale 身份要带 MagicDNS 名');
    assert.notEqual(identity.name, 'localhost');
  }
});

test('环境变量能覆盖节点身份（容器 / 同机第二实例）', async () => {
  const saved = [process.env.DREAMMATE_NODE_ID, process.env.DREAMMATE_NODE_NAME];
  process.env.DREAMMATE_NODE_ID = 'node_forced';
  process.env.DREAMMATE_NODE_NAME = 'forced-name';
  try {
    resetIdentityCache();
    const identity = await sharedIdentity();
    assert.equal(identity.node_id, 'node_forced');
    assert.equal(identity.name, 'forced-name');
  } finally {
    [process.env.DREAMMATE_NODE_ID, process.env.DREAMMATE_NODE_NAME] = saved as [string, string];
    resetIdentityCache();
  }
});


test('serve 的默认端口就是 L0 约定的那个', async () => {
  const { DEFAULT_PORT } = await import('../src/serve/http.js');
  const { DEFAULT_PORTS } = await import('@1agents/dreammate-network');
  // 端口是公共词汇：Control Plane 的 pull 探测照着 L0 的表找服务，
  // 这里自己写一个数字就等于从网络上消失。
  assert.equal(DEFAULT_PORT, DEFAULT_PORTS['session-registry']);
  assert.equal(DEFAULT_PORT, 7777);
  // USAGE 里印给人看的默认值也不能跟它漂开。
  const usage = await fsp.readFile(new URL('../bin/1session.ts', import.meta.url), 'utf8');
  assert.match(usage, new RegExp(`--port ${DEFAULT_PORT}`));
});

test('端口被占用时给人话，不是一屏 Node 栈', async () => {
  const { serve } = await import('../src/serve/http.js');
  const first = await serve({ port: 0, host: '127.0.0.1', report: false });
  const taken = (first.address() as import('node:net').AddressInfo).port;
  try {
    await assert.rejects(
      () => serve({ port: taken, host: '127.0.0.1', report: false }),
      (error: Error) => {
        assert.match(error.message, new RegExp(`端口 ${taken} 已被占用`));
        // 报错要带上怎么办，否则用户还得自己查命令。
        assert.match(error.message, /--port/);
        assert.match(error.message, /lsof/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => first.close(() => resolve()));
  }
});

/* ---------- SQLite 的 NUL 截断 ---------- */

const NUL_CHAR = String.fromCharCode(0x00);
const LEAD_CHAR = String.fromCharCode(0xffff);

test('SQLite 的 TEXT 列确实会在 NUL 处截断——这就是要转义的理由', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (s TEXT)');
  const original = `A${NUL_CHAR}B${NUL_CHAR}C`;
  db.prepare('INSERT INTO t VALUES (?)').run(original);
  // 不报错，安静地只剩第一个 NUL 之前的部分。
  assert.equal(db.prepare('SELECT s FROM t').get()!.s, 'A');
});

test('encodeText / decodeText 往返保真', async () => {
  const { encodeText, decodeText } = await import('../src/store/nul.js');
  const cases = [
    '',
    '普通文本，没有特殊字符',
    `A${NUL_CHAR}B`,
    `${NUL_CHAR}${NUL_CHAR}${NUL_CHAR}`,
    // 实测那条：wsl 的 UTF-16 输出被当 UTF-8 读。
    ` ${NUL_CHAR} ${NUL_CHAR}N${NUL_CHAR}A${NUL_CHAR}M${NUL_CHAR}E${NUL_CHAR}\r${NUL_CHAR}\n`,
    // 引导符自己出现在原文里也必须还原得回来。
    `前${LEAD_CHAR}后`,
    `${LEAD_CHAR}${LEAD_CHAR}`,
    `${LEAD_CHAR}0`,
    `${LEAD_CHAR}${NUL_CHAR}${LEAD_CHAR}0`,
  ];
  for (const value of cases) {
    assert.equal(decodeText(encodeText(value)), value, JSON.stringify(value));
  }
  assert.equal(encodeText(null), null);
  assert.equal(decodeText(undefined), null);
});

test('编码后的文本存进 SQLite 不会丢内容', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { encodeText, decodeText } = await import('../src/store/nul.js');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (s TEXT)');
  const original = `头部${NUL_CHAR}中间${NUL_CHAR}尾部`;
  db.prepare('INSERT INTO t VALUES (?)').run(encodeText(original));
  assert.equal(decodeText(db.prepare('SELECT s FROM t').get()!.s as string), original);
});

test('不含特殊字符时原样返回，不做无谓拷贝', async () => {
  const { encodeText, decodeText } = await import('../src/store/nul.js');
  const plain = '绝大多数内容长这样';
  assert.equal(encodeText(plain), plain);
  assert.equal(decodeText(plain), plain);
});

test('转义后的文本仍然能被 SQL LIKE 搜到', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { encodeText } = await import('../src/store/nul.js');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (s TEXT)');
  // 选转义而不是 BLOB，就是为了保住 text / tool_result 上的 SQL 搜索。
  db.prepare('INSERT INTO t VALUES (?)').run(encodeText(`error${NUL_CHAR}code 42`));
  const hit = db.prepare("SELECT s FROM t WHERE s LIKE '%code 42%'").get();
  assert.ok(hit, 'NUL 之后的内容也要能搜到');
});
