import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { antigravityAdapter } from '../src/parsers/antigravity.js';
import { claudeAdapter } from '../src/parsers/claude.js';
import { codexAdapter } from '../src/parsers/codex.js';
import type { ProviderAdapter } from '../src/parsers/provider.js';
import { aggregateWorkspaceSessions } from '../src/aggregator.js';
import { distillSession } from '../src/distiller.js';
import { listRecentSessions, parseSince, resolveSession } from '../src/resolver.js';
import { searchSessions } from '../src/search.js';
import { canonicalizePath, isInside, slugifyWorkspace } from '../src/util/paths.js';
import { looksLikeInstructions, stripPromptEnvelope } from '../src/util/text.js';

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

/** Every adapter must produce well-formed turns from the newest real session. */
for (const adapter of [antigravityAdapter, claudeAdapter, codexAdapter] as ProviderAdapter[]) {
  test(`${adapter.provider}: parses the newest local session`, async (t) => {
    const candidates = await adapter.listCandidates();
    if (!candidates.length) return t.skip(`no local ${adapter.provider} sessions`);

    const newest = candidates[0]!;
    const ref = await adapter.scanRef(newest);
    assert.equal(ref.provider, adapter.provider);
    assert.equal(ref.id, newest.id);
    assert.ok(path.isAbsolute(ref.path));

    const session = await adapter.parse(newest);
    assert.ok(session.turns.length > 0, 'expected at least one turn');
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
