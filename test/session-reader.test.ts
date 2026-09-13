import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { antigravityAdapter } from '../src/parsers/antigravity.js';
import { claudeAdapter } from '../src/parsers/claude.js';
import { codexAdapter } from '../src/parsers/codex.js';
import type { ProviderAdapter } from '../src/parsers/provider.js';
import type { TurnEvent } from '../src/types.js';
import { aggregateWorkspaceSessions } from '../src/aggregator.js';
import { distillSession } from '../src/distiller.js';
import { listRecentSessions, parseSince, resolveSession } from '../src/resolver.js';
import { searchSessions } from '../src/search.js';
import { buildOverview } from '../src/overview.js';
import { classifyUserTurn } from '../src/classify.js';
import { eventDetail, summarizeTurns, turnDetail } from '../src/turns.js';
import { commandLedger, errorLedger, fileLedger, jobLedger } from '../src/ledger.js';
import { fileWrites, resolveWritePath, stripHeredocs } from '../src/writes.js';
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
  assert.equal(overview.stats.fileChangeSource, session.stats.fileChanges.length ? 'provider' : 'inferred');
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

async function newestOf(provider: 'codex' | 'antigravity' | 'claude') {
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

  assert.ok(commands.every((record) => record.source === 'provider'));
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

  assert.ok(commands.every((record) => record.source === 'parsed'));
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

test('stats.errors matches the error ledger exactly', async (t) => {
  for (const provider of ['codex', 'antigravity', 'claude'] as const) {
    const session = await newestOf(provider);
    if (!session) continue;
    const overview = buildOverview(session);
    assert.equal(overview.stats.errors, errorLedger(session).length, `${provider} error counts disagree`);
    assert.equal(overview.stats.commands, commandLedger(session).length, `${provider} command counts disagree`);
  }
  t.diagnostic('checked every provider with a local session');
});
