import assert from 'node:assert/strict';
import test from 'node:test';
import { convertSessionToDshEvents } from '../src/dsh/adapter.js';
import { listRecentSessions, resolveSession } from '../src/resolver.js';
import type { NormalizedSession } from '../src/types.js';

test('convertSessionToDshEvents converts synthetic NormalizedSession into valid DSH events', () => {
  const mockSession: NormalizedSession = {
    ref: {
      id: 'test-123',
      provider: 'claude',
      path: '/tmp/test.jsonl',
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: '2026-09-16T10:05:00.000Z',
    },
    artifacts: [],
    stats: {
      models: ['claude-3-7-sonnet'],
      branches: ['main'],
      fileChanges: [],
      uploads: [],
      backgroundTasks: [],
      turnBoundaries: [],
      commands: [],
      extras: {},
    },
    turns: [
      {
        id: '1',
        index: 0,
        kind: 'user',
        text: 'Hello world, please check the status',
        timestamp: '2026-09-16T10:00:01.000Z',
      },
      {
        id: '2',
        index: 1,
        kind: 'thinking',
        text: 'Thinking about checking git status...',
        timestamp: '2026-09-16T10:00:02.000Z',
      },
      {
        id: '3',
        index: 2,
        kind: 'tool_call',
        toolName: 'run_command',
        toolArgs: { CommandLine: 'git status' },
        timestamp: '2026-09-16T10:00:03.000Z',
      },
      {
        id: '3',
        index: 3,
        kind: 'tool_result',
        toolName: 'run_command',
        toolResult: 'On branch main\nnothing to commit, working tree clean',
        exitCode: 0,
        timestamp: '2026-09-16T10:00:04.000Z',
      },
      {
        id: '4',
        index: 4,
        kind: 'assistant',
        text: 'The git repository is clean and on branch main.',
        timestamp: '2026-09-16T10:00:05.000Z',
      },
    ],
  };

  const dshEvents = convertSessionToDshEvents(mockSession);
  assert(dshEvents.length > 0, 'Should produce events');

  // Verify sequential seq numbers (0-based)
  for (let i = 0; i < dshEvents.length; i++) {
    assert.equal(dshEvents[i]!.seq, i, `seq should be strictly increasing from 0: ${i}`);
  }

  // Verify turn/start
  const turnStart = dshEvents.find((e) => e.type === 'turn/start');
  assert(turnStart, 'Must emit turn/start');
  assert.equal(turnStart.data.turn, 1);

  // Verify user/message
  const userMsg = dshEvents.find((e) => e.type === 'user/message');
  assert(userMsg, 'Must emit user/message');
  assert.equal(userMsg.surfaceOp, 'append');
  assert.equal((userMsg.data.content as any)[0].text, 'Hello world, please check the status');

  // Verify thinking (assistant/message with stream reasoning-delta)
  const thinkingMsg = dshEvents.find((e) => e.type === 'assistant/message' && (e.data.stream as any)?.some((r: any) => r.chunk?.type === 'reasoning-delta'));
  assert(thinkingMsg, 'Must emit reasoning chunks for thinking');
  assert.equal(thinkingMsg.surfaceOp, 'append');
  assert.equal((thinkingMsg.data.stream as any)[1].chunk.text, 'Thinking about checking git status...');

  // External tool history is visible text; it cannot start a DSH tool lifecycle.
  const external = dshEvents.filter(e => e.type === 'assistant/message').flatMap(e => (e.data.message as any).content).map(b => b.text);
  assert(external.some(text => text.includes('[External tool call · run_command]')));
  assert(external.some(text => text.includes('[External tool result · run_command · exit 0]')));
  assert(!dshEvents.some(e => e.type === 'tool/call' || e.type === 'tool/result'));

  // Verify final assistant/message
  const assistantMsg = dshEvents.find((e) => e.type === 'assistant/message' && (e.data.stream as any)?.some((r: any) => r.chunk?.type === 'text-delta'));
  assert(assistantMsg, 'Must emit assistant message');
  assert.equal(assistantMsg.surfaceOp, 'append');

  // Verify turn/end
  const turnEnd = dshEvents.find((e) => e.type === 'turn/end');
  assert(turnEnd, 'Must emit turn/end');
  assert.equal(turnEnd.data.turn, 1);
});

test('convertSessionToDshEvents converts real sessions on this machine', async () => {
  const sessions = await listRecentSessions({ limit: 5 });
  if (sessions.length === 0) return;

  for (const sessionRef of sessions) {
    const resolved = await resolveSession(sessionRef.id);
    if (!resolved) continue;
    const normalized = await resolved.adapter.parse(resolved.candidate);
    const events = convertSessionToDshEvents(normalized);

    if (normalized.turns.length === 0) continue;
    assert(events.length > 0, `Session ${sessionRef.id} (${sessionRef.provider}) must emit events`);

    // Verify sequences are strictly increasing from 0
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i]!.seq, i);
      assert(typeof events[i]!.time === 'number');
      assert(events[i]!.type.length > 0);
    }
  }
});

test('plugin GET /sessions returns index metadata only; GET /session/:id loads one session without dshEvents', async (t) => {
  const { apply } = await import('../src/dsh/plugin.js');
  let handler: ((req: any, res: any) => Promise<void>) | undefined;
  apply({
    effect: (setup: () => unknown) => setup(),
    webServer: {
      register: (route: any) => {
        handler = route.handler;
      },
    },
  });
  assert.ok(handler, 'HTTP handler must be registered');

  const listRes: any = { statusCode: 0, setHeader() {}, end(data: string) { listRes.body = data; } };
  await handler!(
    { url: '/api/session-reader/sessions?limit=3&scope=global', method: 'GET', headers: { host: '127.0.0.1' } },
    listRes,
  );
  assert.equal(listRes.statusCode, 200, listRes.body);
  const listBody = JSON.parse(listRes.body);
  assert.ok(Array.isArray(listBody.sessions));
  for (const session of listBody.sessions) {
    assert.ok(session.id);
    assert.equal(session.turns, undefined);
    assert.equal(session.overview, undefined);
    assert.equal(session.dshEvents, undefined);
  }

  const target = listBody.sessions[0];
  if (!target) return t.skip('no indexed sessions to lazy-load');

  const detailRes: any = { statusCode: 0, setHeader() {}, end(data: string) { detailRes.body = data; } };
  await handler!(
    { url: `/api/session-reader/session/${encodeURIComponent(target.id)}`, method: 'GET', headers: { host: '127.0.0.1' } },
    detailRes,
  );
  assert.equal(detailRes.statusCode, 200, detailRes.body);
  const detail = JSON.parse(detailRes.body);
  assert.ok(detail.ref);
  assert.ok(Array.isArray(detail.turns));
  assert.ok(Array.isArray(detail.files), 'preview includes the file ledger for the files tab');
  assert.equal(detail.dshEvents, undefined, 'preview must not convert the whole session to DSH events');
});

test('DSH browser client bundle registers with ModuleLoader exactly once and exports apply and inject', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const clientBundlePath = path.resolve('dist/src/dsh/client.js');
  const webBundlePath = path.resolve('dist/src/web/app.js');
  if (!fs.existsSync(clientBundlePath) || !fs.existsSync(webBundlePath)) {
    execFileSync(process.execPath, ['scripts/bundle-client.js'], { stdio: 'inherit' });
  }
  assert(fs.existsSync(clientBundlePath), 'dist/src/dsh/client.js must exist after build');
  assert(fs.existsSync(webBundlePath), 'dist/src/web/app.js must exist after build');

  const bundleCode = fs.readFileSync(clientBundlePath, 'utf8');

  // Must not have nested / duplicate __ModuleLoader__.load
  const loadMatches = bundleCode.match(/window\.__ModuleLoader__\.load\s*\(/g) || [];
  assert.equal(loadMatches.length, 1, 'Expected window.__ModuleLoader__.load to be called exactly once');

  let loadCallCount = 0;
  let registeredId = '';
  let registeredFactory: any = null;

  const mockWindow: any = {
    __ModuleLoader__: {
      load: (entry: { id: string; factory: any }) => {
        loadCallCount++;
        registeredId = entry.id;
        registeredFactory = entry.factory;
      },
    },
  };

  // Evaluate the bundle in an isolated Function scope with window mocked
  const evalBundle = new Function('window', bundleCode);
  evalBundle(mockWindow);

  assert.equal(loadCallCount, 1, 'Script evaluation must call load exactly once');
  assert.equal(registeredId, '@1agents/session-reader', 'Must register with id "@1agents/session-reader"');
  assert.equal(typeof registeredFactory, 'function', 'Factory must be a function');

  // Materialize module
  const materialized = registeredFactory((_spec: string) => {
    throw new Error('Unexpected require: ' + _spec);
  });

  assert.equal(loadCallCount, 1, 'Materialization must NOT call load a second time (no duplicate registration)');
  assert.equal(typeof materialized.apply, 'function', 'Materialized exports must have apply function');
  assert.deepEqual(materialized.inject, ['sessions', 'workspaces', 'uiWorkspace', 'uiSession', 'locale'], 'Materialized exports must declare inject');
});



test('import history preserves ordered tool records and closes an unfinished tail without fabricating an answer', async () => {
  const { readFile } = await import('node:fs/promises');
  const history: NormalizedSession = JSON.parse(await readFile(new URL('./fixtures/dsh-import/history.json', import.meta.url), 'utf8'));
  const expected = JSON.parse(await readFile(new URL('./fixtures/dsh-import/events.json', import.meta.url), 'utf8'));
  assert.deepEqual(convertSessionToDshEvents(history), expected);
  const invalidDate = convertSessionToDshEvents({ ...history, ref: { ...history.ref, createdAt: 'invalid' } });
  assert.ok(invalidDate.every(event => Number.isFinite(event.time)));
});
