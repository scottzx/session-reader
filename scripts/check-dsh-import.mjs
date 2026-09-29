/** Verify fixture imports against a built DSH checkout, including its actual stream validator. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convertSessionToDshEvents } from '../dist/src/dsh/adapter.js';
const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/check-dsh-import.mjs /path/to/DSH');
const { Session } = await import(pathToFileURL(resolve(root, 'packages/core/session/lib/index.js')).href);
const { expandAssistantStream } = await import(pathToFileURL(resolve(root, 'packages/llm/llm/lib/index.js')).href);
const history = JSON.parse(await readFile(new URL('../test/fixtures/dsh-import/history.json', import.meta.url), 'utf8'));
const events = convertSessionToDshEvents(history);
const session = Session.create('session-fixture', events);
assert.deepEqual(session.deriveMessages().map(m => m.role), ['user', 'assistant', 'assistant', 'assistant', 'assistant', 'user']);
for (const event of events) if (event.type === 'assistant/message') assert.ok([...expandAssistantStream(event.data.stream)].length >= 3);
console.log('DSH accepts the imported history and embedded streams');

const { sessionFormatCatalog: catalog } = await import(pathToFileURL(resolve(root, 'packages/session/session-format-catalog/lib/index.js')).href);
const restore = catalog.createRestore(catalog.encodeCurrentHeader({ ...session.header, delegationDepth: 0 }, 0), { recovery: 'strict', validation: 'current' });
for (const event of session.snapshotEvents()) restore.decodeRow(catalog.encodeCurrentEvent(event));
restore.finish();
// Resuming appends a system update; this requires the imported surface's protected head.
const next = Session.create('session-fixture', events);
next.append('turn/start', { turn: 3 });
next.append('step/start', { turn: 3, step: 1 });
next.append('system/message', { turn: 3, step: 1, message: { id: 'next-system', role: 'system', source: { kind: 'system-prompt' }, content: [] } }, { surfaceOp: 'append' });
const resumed = catalog.createRestore(catalog.encodeCurrentHeader({ ...next.header, delegationDepth: 0 }, 0), { recovery: 'strict', validation: 'current' });
for (const event of next.snapshotEvents()) resumed.decodeRow(catalog.encodeCurrentEvent(event));
resumed.finish();
console.log('DSH durable format accepts the import before and after a resumed system update');

const withoutHead = next.snapshotEvents().filter(event => event.type !== 'system/message' || event.data.message.id !== `system-${history.ref.id}`).map((event, seq) => ({ ...event, seq }));
assert.throws(() => {
  const invalid = catalog.createRestore(catalog.encodeCurrentHeader({ ...next.header, delegationDepth: 0 }, 0), { recovery: 'strict', validation: 'current' });
  for (const event of withoutHead) invalid.decodeRow(catalog.encodeCurrentEvent(event));
  invalid.finish();
}, /protected first surface head/);
