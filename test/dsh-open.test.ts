import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { apply } from '../src/dsh/plugin.js';
import { adapters } from '../src/resolver.js';
import { openSessionInDsh, continuationAvailability } from '../src/dsh/open.js';
import { emptyProviderStats, type AgentProvider, type NormalizedSession } from '../src/types.js';
import type { ProviderAdapter } from '../src/parsers/provider.js';

function source(provider: AgentProvider): ProviderAdapter {
  const normalized: NormalizedSession = {
    ref: { provider, id: 'same-native-id', path: `/fixture/${provider}.jsonl`, workspace: '/original/workspace', title: 'Imported history' },
    turns: [{ id: '1', index: 0, kind: 'user', text: 'old question' }],
    artifacts: [], stats: emptyProviderStats(),
  };
  return { provider, listCandidates: async () => [{ id: normalized.ref.id, path: normalized.ref.path, mtimeMs: 1, sizeBytes: 1 }], scanRef: async () => normalized.ref, parse: async () => normalized };
}

test('tool and HTTP admission share the ACP service and retain the native provider identity', async t => {
  const original = adapters.splice(0, adapters.length, source('claude'), source('codex'));
  t.after(() => { adapters.splice(0, adapters.length, ...original); });
  const calls: any[] = [], effects: any[] = [], tools = new Map();
  let route: any;
  const service = {
    availability: async () => ({ available: true, agent: 'codex' }),
    importSession: async (value: any) => { calls.push(value); return { success: true, continuation: 'native' as const, dshSessionId: 'session-imported' }; },
  };
  apply({ get: () => service, effect: (setup: any) => effects.push(setup()), tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, webServer: { register: (value: any) => { route = value; return () => {}; } } });
  const first = await tools.get('session_open_in_dsh').execute({ sessionId: 'same-native-id', provider: 'codex' });
  assert.equal(first.dshSessionId, 'session-imported');
  const request = Object.assign(Readable.from([JSON.stringify({ sessionId: 'same-native-id', provider: 'codex' })]), { url: '/api/session-reader/open-in-dsh', method: 'POST', headers: { host: 'localhost', origin: 'http://localhost' } });
  const response = { statusCode: 200, body: '', setHeader() {}, end(value: string) { this.body = value; } };
  await route.handler(request, response);
  assert.deepEqual(JSON.parse(response.body), first);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.provider === 'codex' && c.nativeSessionId === 'same-native-id' && c.cwd === '/original/workspace'));
  assert.deepEqual(calls[0].events.map((event: any) => event.type), ['session/title', 'turn/start', 'step/start', 'system/message', 'user/message', 'step/end', 'turn/end']);
  assert.equal(calls[0].events.at(-1).data.reason.kind, 'interrupted');
  for (const dispose of effects) dispose();
  assert.equal(tools.size, 0);
});

test('missing ACP keeps history read-only, while native DSH opens its existing identity', async t => {
  const original = adapters.splice(0, adapters.length, source('dsh'), source('claude'));
  t.after(() => { adapters.splice(0, adapters.length, ...original); });
  const opened: string[] = [], attached: string[] = [];
  const ctx = { get: () => undefined,
    sessionController: { resolveAgent: async (id: string) => { opened.push(id); return { agent: { session: { header: { cwd: '/native/dsh/workspace' } } } }; } },
    workspaceRegistry: { create: async (cwd: string) => { assert.equal(cwd, '/native/dsh/workspace'); return { id: 'workspace', attachSession: async (id: string) => { attached.push(id); } }; } },
  };
  assert.equal((await continuationAvailability(ctx, { provider: 'claude' })).available, false);
  await assert.rejects(openSessionInDsh(ctx, { sessionId: 'same-native-id', provider: 'claude' }), /acp-service/);
  assert.deepEqual(opened, []);
  assert.equal((await openSessionInDsh(ctx, { sessionId: 'same-native-id', provider: 'dsh' })).continuation, 'dsh');
  assert.deepEqual(opened, ['session-same-native-id']);
  assert.deepEqual(attached, opened);
});

test('HTTP refuses mutation through GET or another origin and returns failed imports as errors', async t => {
  const original = adapters.splice(0, adapters.length, source('codex'));
  t.after(() => { adapters.splice(0, adapters.length, ...original); });
  let route: any;
  apply({ effect: (setup: any) => setup(), get: () => ({ availability: async () => ({ available: true }), importSession: async () => { throw new Error('Native authentication failed'); } }), webServer: { register: (value: any) => { route = value; return () => {}; } } });
  for (const [method, origin, expected] of [['GET', 'http://localhost', 405], ['POST', 'http://elsewhere', 403], ['POST', 'http://localhost', 500]] as const) {
    const request = Object.assign(Readable.from([JSON.stringify({ sessionId: 'same-native-id', provider: 'codex' })]), { method, url: '/api/session-reader/open-in-dsh', headers: { host: 'localhost', origin } });
    const response = { statusCode: 200, body: '', setHeader() {}, end(value: string) { this.body = value; } };
    await route.handler(request, response);
    assert.equal(response.statusCode, expected);
    assert.equal(JSON.parse(response.body).success, undefined);
    if (expected === 500) assert.match(JSON.parse(response.body).error, /authentication failed/);
  }
});
