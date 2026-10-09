import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import { decodeZstd } from './util/zstd.js';
import { callsIn } from './calls.js';
import { parseEventSpec, summarizeTurns } from './turns.js';
import { indexedHandle, loadSession, resolveSession } from './resolver.js';
import { openStore } from './store/db.js';
import { refreshSession } from './store/indexer.js';
import { eventsOf, findSessionRow, refOf, sessionRow } from './store/read.js';
function bodyOf(event) {
    return event.kind === 'tool_call' ? JSON.stringify(event.toolArgs ?? {}, null, 2)
        : event.fullText ?? event.text ?? event.toolResult ?? '';
}
/** Cursors bind to the selected originals; appended unrelated records do not invalidate them. */
export function contentPage(events, options = {}) {
    const bodies = events.map(bodyOf);
    const key = createHash('sha256').update(JSON.stringify(events.map((event, i) => [event.locator ?? event.id, bodies[i]]))).digest('hex');
    let at = 0;
    let offset = 0;
    if (options.cursor) {
        try {
            const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
            if (cursor.key !== key || !Number.isInteger(cursor.at) || !Number.isInteger(cursor.offset)
                || cursor.at < 0 || cursor.at >= events.length || cursor.offset < 0 || cursor.offset > bodies[cursor.at].length)
                throw new Error();
            at = cursor.at;
            offset = cursor.offset;
        }
        catch {
            throw new Error('invalid content cursor or source changed');
        }
    }
    const budget = options.maxChars ?? 32_000;
    if (!Number.isInteger(budget) || budget < 1 || budget > 1_000_000)
        throw new Error('maxChars must be an integer between 1 and 1000000');
    let remaining = budget;
    const items = [];
    while (at < events.length && remaining > 0) {
        const event = events[at];
        const body = bodies[at];
        let end = Math.min(offset + remaining, body.length);
        // Do not split a UTF-16 surrogate pair between pages.
        if (end < body.length && end > offset && /[\uD800-\uDBFF]/.test(body[end - 1]))
            end--;
        if (end === offset && body.length > offset)
            end = Math.min(offset + 2, body.length);
        const content = body.slice(offset, end);
        items.push({
            index: event.index, kind: event.kind, field: event.kind === 'tool_call' ? 'arguments' : event.kind === 'tool_result' ? 'result' : 'text',
            content, offset, totalChars: body.length,
            ...(event.locator ? { locator: event.locator } : {}), ...(event.callId ? { callId: event.callId } : {}),
            ...(event.toolName ? { toolName: event.toolName } : {}), ...(event.timestamp ? { timestamp: event.timestamp } : {}),
            ...(event.source ? { source: event.source } : {}), ...(event.truncated ? { providerTruncated: true } : {}),
            ...(event.fullText !== undefined ? { recovered: true } : {}), ...(event.truncationNote ? { truncationNote: event.truncationNote } : {}),
        });
        remaining -= content.length;
        if (end < body.length) {
            offset = end;
            break;
        }
        at++;
        offset = 0;
    }
    return { items, ...(at < events.length ? { nextCursor: Buffer.from(JSON.stringify({ key, at, offset })).toString('base64url') } : {}) };
}
async function indexedSession(id, options = {}) {
    const db = await openStore();
    const known = findSessionRow(db, id);
    const handle = (known && known.id.toLowerCase() === id.toLowerCase() ? await indexedHandle(known) : undefined) ?? await resolveSession(id);
    if (!handle)
        throw new Error(`session not found: ${id}`);
    const refreshed = await refreshSession(db, handle, { edges: false, force: options.force });
    return { db, row: sessionRow(db, refreshed.id) };
}
function direct(options) {
    return options.useIndex === false || process.env.SESSION_READER_NO_INDEX === '1';
}
function summariesIn(session, spec) {
    const summaries = summarizeTurns(session);
    return parseEventSpec(spec, summaries.length + 1).map((no) => {
        const summary = summaries[no - 1];
        if (!summary)
            throw new Error(`no turn ${no} (session has ${summaries.length})`);
        return summary;
    });
}
/** Reads a batch of turn ranges without rebuilding all indexed session events. */
export async function readTurns(id, spec, options = {}) {
    let session;
    let summaries;
    let events;
    if (direct(options)) {
        const normalized = await loadSession(id, options);
        session = normalized.ref;
        summaries = summariesIn(normalized, spec);
        events = summaries.flatMap((summary) => normalized.turns.slice(summary.events[0], summary.events[1] + 1));
    }
    else {
        const { db, row } = await indexedSession(id, options);
        session = refOf(row);
        summaries = parseEventSpec(spec, row.turn_count + 1).map((no) => {
            const stored = db.prepare('SELECT summary_json FROM turn_ranges WHERE session_id = ? AND no = ?').get(row.id, no);
            if (!stored)
                throw new Error(`no turn ${no} (session has ${row.turn_count})`);
            return JSON.parse(stored.summary_json);
        });
        events = summaries.flatMap((summary) => eventsOf(db, row.id, row.native_id, ...summary.events));
    }
    return { session, summaries, tools: callsIn(events), ...contentPage(events.filter((event) => event.kind === 'user' || event.kind === 'assistant'), options) };
}
/** The directory is persisted during indexing; listing it need not hydrate every event. */
export async function readTurnDirectory(id, options = {}) {
    if (direct(options)) {
        const normalized = await loadSession(id, options);
        return { session: normalized.ref, eventCount: normalized.turns.length, turns: summarizeTurns(normalized) };
    }
    const { db, row } = await indexedSession(id, options);
    const rows = db.prepare('SELECT summary_json FROM turn_ranges WHERE session_id = ? ORDER BY no').all(row.id);
    return { session: refOf(row), eventCount: row.event_count, turns: rows.map((item) => JSON.parse(item.summary_json)) };
}
/** Numeric E aliases remain supported; native source locators are exact selectors. */
async function selectedEvents(id, selectors, options = {}) {
    let session;
    let events = [];
    if (direct(options)) {
        const normalized = await loadSession(id, options);
        session = normalized.ref;
        for (const selector of selectors) {
            const found = selector.startsWith('event:') ? normalized.turns.filter((event) => event.locator === selector)
                : parseEventSpec(selector, normalized.turns.length).map((index) => normalized.turns[index]).filter((event) => !!event);
            if (!found.length)
                throw new Error(`event not found or source changed: ${selector}`);
            events.push(...found);
        }
    }
    else {
        const { db, row } = await indexedSession(id, options);
        session = refOf(row);
        for (const selector of selectors) {
            if (selector.startsWith('event:')) {
                const matches = db.prepare('SELECT idx FROM events WHERE session_id = ? AND locator = ?').all(row.id, selector);
                if (matches.length !== 1)
                    throw new Error(`event not found, ambiguous, or source changed: ${selector}`);
                events.push(...eventsOf(db, row.id, row.native_id, matches[0].idx, matches[0].idx));
            }
            else {
                for (const index of parseEventSpec(selector, row.event_count)) {
                    const found = eventsOf(db, row.id, row.native_id, index, index);
                    if (!found.length)
                        throw new Error(`no event ${index}`);
                    events.push(...found);
                }
            }
        }
    }
    events = [...new Map(events.map((event) => [event.index, event])).values()].sort((a, b) => a.index - b.index);
    return { session, events };
}
export async function readEvents(id, selectors, options = {}) {
    const { session, events } = await selectedEvents(id, selectors, options);
    return { session, ...contentPage(events, options) };
}
/** Returns the exact JSONL records, including envelopes omitted by the dialogue view. */
export async function readOriginalRecords(id, selectors, options = {}) {
    const { session, events } = await selectedEvents(id, selectors, options);
    const wanted = new Map(events.map((event) => [event.source.record, event]));
    const originals = new Map();
    const stream = session.path.endsWith('.zstd') ? undefined : fs.createReadStream(session.path, { encoding: 'utf8' });
    const lines = stream ? readline.createInterface({ input: stream, crlfDelay: Infinity })
        : decodeZstd(await readFile(session.path)).split(/\r?\n/);
    let record = -1;
    try {
        for await (const raw of lines) {
            let value;
            try {
                value = JSON.parse(raw);
            }
            catch {
                continue;
            }
            if (!value || typeof value !== 'object')
                continue;
            record++;
            const event = wanted.get(record);
            if (!event)
                continue;
            const checksum = createHash('sha256').update(JSON.stringify(value)).digest('hex');
            if (checksum !== event.source.checksum)
                throw new Error('source changed while reading original record');
            originals.set(record, raw);
            if (originals.size === wanted.size)
                break;
        }
    }
    finally {
        if (stream) {
            lines.close();
            stream.destroy();
        }
    }
    if (originals.size !== wanted.size)
        throw new Error('original record not found or source changed');
    const selected = [...wanted.values()].sort((a, b) => a.index - b.index);
    const page = contentPage(selected.map((event) => ({ ...event, kind: 'assistant', text: originals.get(event.source.record), fullText: undefined })), options);
    return { session, ...page, items: page.items.map((item) => ({ ...item, kind: selected.find((event) => event.index === item.index).kind, field: 'record' })) };
}
export async function readCall(id, callId, options = {}) {
    let session;
    let events;
    if (direct(options)) {
        const normalized = await loadSession(id, options);
        session = normalized.ref;
        const calls = normalized.turns.filter((event) => event.kind === 'tool_call' && (event.callId === callId || event.locator === callId));
        if (calls.length !== 1)
            throw new Error(`call not found or ambiguous: ${callId}`);
        const call = calls[0];
        events = [call, ...normalized.turns.filter((event) => event.kind === 'tool_result' && !!call.callId && event.callId === call.callId)];
    }
    else {
        const { db, row } = await indexedSession(id, options);
        session = refOf(row);
        const calls = db.prepare("SELECT idx, call_id FROM events WHERE session_id = ? AND kind = 'tool_call' AND (call_id = ? OR locator = ?)").all(row.id, callId, callId);
        if (calls.length !== 1)
            throw new Error(`call not found or ambiguous: ${callId}`);
        const call = calls[0];
        const indices = call.call_id ? db.prepare("SELECT idx FROM events WHERE session_id = ? AND call_id = ? AND kind = 'tool_result' ORDER BY idx").all(row.id, call.call_id) : [];
        events = [call, ...indices].flatMap(({ idx }) => eventsOf(db, row.id, row.native_id, idx, idx));
    }
    return { session, association: events[0].callId ? 'native_id' : 'unconfirmed', ...contentPage(events, options) };
}
export async function readArtifact(id, artifactPath, options = {}) {
    let session;
    let artifacts;
    if (direct(options)) {
        const normalized = await loadSession(id, options);
        session = normalized.ref;
        artifacts = normalized.artifacts;
    }
    else {
        const { row } = await indexedSession(id, options);
        session = refOf(row);
        artifacts = row.artifacts_json ? JSON.parse(row.artifacts_json) : [];
    }
    const artifact = artifacts.find((item) => item.path === artifactPath);
    if (!artifact)
        throw new Error(`artifact not found: ${artifactPath}`);
    if (artifact.content === undefined)
        throw new Error(`artifact has no readable text: ${artifactPath}`);
    const event = { id: artifact.path, index: -1, kind: 'assistant', text: artifact.content };
    return { session, artifact: { name: artifact.name, path: artifact.path, kind: artifact.kind }, ...contentPage([event], options) };
}
