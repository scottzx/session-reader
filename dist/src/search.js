import { createHash } from 'node:crypto';
import { adapters, listResolvedSessions, parseSince } from './resolver.js';
import { turnNoAt, turnStarts } from './turns.js';
import { canonicalizePath, isInside } from './util/paths.js';
const DEFAULT_CONTEXT = 100;
const DEFAULT_MAX_PER_SESSION = 5;
const HARD_CAP = 200;
function buildPattern(query, options) {
    const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(source, options.caseSensitive ? 'g' : 'gi');
}
/** Slices around the match first, then collapses whitespace, so offsets stay valid. */
function excerpt(body, at, length, context) {
    const start = Math.max(0, at - context);
    const end = Math.min(body.length, at + length + context);
    const slice = body.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${slice}${end < body.length ? '…' : ''}`;
}
// ---------------------------------------------------------------------------
// Query planning
// ---------------------------------------------------------------------------
/** Escapes that stand for a class of characters rather than one literal one. */
const CLASS_ESCAPES = new Set('dDwWsSbBnrtfv0xucpPk'.split(''));
/**
 * A substring that every string matching `source` must contain, or `undefined`
 * when no such substring can be proven.
 *
 * Deliberately timid: alternation or groups anywhere and it gives up. A
 * prefilter that is merely usually right would hand back "searched everything"
 * answers that quietly missed rows — the exact failure this store exists to
 * remove — so "no literal" is always the safe reply.
 */
export function mandatoryLiteral(source) {
    if (/[|()]/.test(source))
        return undefined;
    let best = '';
    let run = '';
    const flush = () => {
        if (run.length > best.length)
            best = run;
        run = '';
    };
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch === '\\') {
            const next = source[++i];
            if (next === undefined)
                break;
            if (CLASS_ESCAPES.has(next))
                flush();
            else
                run += next; // an escaped literal character
            continue;
        }
        if (ch === '[') {
            flush();
            while (i < source.length && source[i] !== ']')
                i += source[i] === '\\' ? 2 : 1;
            continue;
        }
        // `?`, `*` and `{…}` can make the preceding character disappear, so it
        // stops being mandatory. `+` keeps it (one occurrence at least).
        if (ch === '?' || ch === '*') {
            run = run.slice(0, -1);
            flush();
            continue;
        }
        if (ch === '{') {
            run = run.slice(0, -1);
            flush();
            while (i < source.length && source[i] !== '}')
                i++;
            continue;
        }
        if (ch === '+' || ch === '.' || ch === '^' || ch === '$') {
            flush();
            continue;
        }
        run += ch;
    }
    flush();
    return best.length >= 2 ? best : undefined;
}
/** True when a character is unaffected by case folding (CJK, digits, punctuation). */
function caseless(ch) {
    return ch.toLowerCase() === ch && ch.toUpperCase() === ch;
}
function longestCaselessRun(value) {
    let best = '';
    let run = '';
    for (const ch of value) {
        if (caseless(ch)) {
            run += ch;
            if (run.length > best.length)
                best = run;
        }
        else {
            run = '';
        }
    }
    return best;
}
/**
 * Turns a query into an optional SQL prefilter.
 *
 * Case folding has to agree with what the matcher does. A `gi` regex without
 * the `u` flag folds ASCII only — exactly what SQLite's `lower()` does — so an
 * ASCII literal can be folded on both sides. Anything else falls back to the
 * longest run of characters that have no case at all, where folding is a no-op
 * either way.
 */
export function planQuery(query, options = {}) {
    const raw = options.regex ? mandatoryLiteral(query) : query;
    // A literal spanning a newline could straddle two columns, which the
    // per-column prefilter would miss.
    if (!raw || raw.length < 2 || raw.includes('\n'))
        return {};
    if (options.caseSensitive)
        return { literal: raw };
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7F]*$/.test(raw))
        return { literal: raw.toLowerCase(), fold: true };
    const run = longestCaselessRun(raw);
    return run.length >= 2 ? { literal: run } : {};
}
// ---------------------------------------------------------------------------
// The searcher's own footprint
// ---------------------------------------------------------------------------
/**
 * How recent a `1session` invocation has to be to be this very search rather
 * than a historical one. The agent's tool call is written to its transcript
 * seconds before the command runs, so the window only has to survive the
 * indexing sweep — but a past session that genuinely ran the same query must
 * stay a real hit, which is what keeps this narrow.
 */
const SELF_ECHO_WINDOW_MS = 5 * 60_000;
/** How far after the invocation its own output may land, as in `commandLedger`. */
const RESULT_SPAN = 3;
const INVOCATION = /(?:^|[\s"'`/])1session\s/;
/**
 * A `1session` invocation written in the last few minutes.
 *
 * Only the live transcript can hold one: a session that ended yesterday cannot
 * have an event timestamped now, so the window is what separates "this
 * investigation, happening" from "someone once ran this", and no past session
 * is ever touched by it.
 */
function isRunningInvocation(candidate, now) {
    if (candidate.kind !== 'tool_call' || !candidate.timestamp)
        return false;
    const at = Date.parse(candidate.timestamp);
    if (!Number.isFinite(at) || at < now - SELF_ECHO_WINDOW_MS || at > now + 60_000)
        return false;
    return INVOCATION.test(candidate.body);
}
/**
 * Folds the Read Plane's own footprint out of one session: an invocation
 * running right now, and the result carrying what it printed.
 *
 * It deliberately does not require the invocation to carry *this* query. A
 * `1session` call from a minute ago prints other sessions' content verbatim,
 * so it matches queries it never mentioned — and whatever it echoed is still
 * in the session it was quoting from, where the search finds it properly, with
 * a handle that drills down to the real thing instead of to a screenful of
 * this tool's output.
 *
 * Stateful because the second half is only knowable from the first, so it is
 * built fresh per session and fed events in index order — which both search
 * paths already produce.
 */
export function echoFolder(now) {
    let lastEcho = Number.NEGATIVE_INFINITY;
    return (candidate) => {
        if (isRunningInvocation(candidate, now)) {
            lastEcho = candidate.index;
            return true;
        }
        return candidate.kind === 'tool_result' && candidate.index - lastEcho <= RESULT_SPAN;
    };
}
/**
 * Whether a session is the one running the search. Accepts the canonical
 * `provider:native_id`, the bare native id, or a 6+ character prefix of it —
 * the same spellings `resolveSession` takes.
 */
export function isCallerSession(ref, callerId) {
    const caller = callerId?.trim().toLowerCase();
    if (!caller)
        return false;
    const native = ref.id.toLowerCase();
    const canonical = `${ref.provider}:${native}`;
    if (caller.includes(':') && caller.split(':')[0] !== ref.provider)
        return false;
    const bare = caller.includes(':') ? caller.slice(caller.indexOf(':') + 1) : caller;
    return caller === canonical || bare === native || (bare.length >= 6 && native.startsWith(bare));
}
function eventDocument(event) {
    return {
        index: event.index, kind: event.kind, timestamp: event.timestamp,
        toolName: event.toolName, locator: event.locator, callId: event.callId,
        fields: {
            text: event.kind === 'user' || event.kind === 'assistant' || event.kind === 'thinking' ? event.fullText ?? event.text : undefined,
            tool_name: event.toolName,
            tool_args: event.toolArgs ? JSON.stringify(event.toolArgs) : undefined,
            tool_result: event.kind === 'tool_result' ? event.fullText ?? event.toolResult : undefined,
        },
    };
}
function metadataDocuments(ref, artifacts, options) {
    const docs = [];
    const area = options.area ?? 'dialogue';
    if (!options.kinds?.length && (area === 'dialogue' || area === 'all')) {
        docs.push({ index: -1, kind: 'metadata', fields: {
                title: ref.title,
                ...Object.fromEntries((ref.titles ?? []).map((title, i) => [`title.${title.source}.${i}`, title.text])),
                summary: ref.summary,
            } });
    }
    if (!options.kinds?.length && (area === 'artifacts' || area === 'all')) {
        for (const artifact of artifacts)
            docs.push({
                index: -1, kind: 'artifact', artifactPath: artifact.path, timestamp: artifact.updatedAt,
                fields: { artifact_name: artifact.name, artifact_path: artifact.path, artifact_summary: artifact.summary, artifact_content: artifact.content },
            });
    }
    return docs;
}
function kindsOf(options) {
    if (options.kinds?.length)
        return options.kinds;
    switch (options.area ?? 'dialogue') {
        case 'tools': return ['tool_call', 'tool_result'];
        case 'artifacts': return [];
        case 'all': return ['user', 'assistant', 'tool_call', 'tool_result'];
        default: return ['user', 'assistant'];
    }
}
function matchDocument(doc, patterns, options) {
    const fields = [];
    const matched = new Set();
    const context = options.context ?? DEFAULT_CONTEXT;
    for (const [field, body] of Object.entries(doc.fields)) {
        if (!body)
            continue;
        const ranges = [];
        let hasMoreRanges = false;
        patterns.forEach((pattern, i) => {
            pattern.lastIndex = 0;
            for (const match of body.matchAll(pattern)) {
                matched.add(i);
                // Broad regexes such as '.' must not allocate one range per character.
                if (ranges.length >= 20) {
                    hasMoreRanges = true;
                    break;
                }
                ranges.push([match.index, match.index + match[0].length]);
            }
        });
        if (!ranges.length)
            continue;
        ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const unique = ranges.filter((range, i) => !i || range[0] !== ranges[i - 1][0] || range[1] !== ranges[i - 1][1]);
        fields.push({ field, ranges: unique, excerpts: unique.slice(0, 3).map(([from, to]) => excerpt(body, from, to - from, context)), ...(hasMoreRanges ? { hasMoreRanges: true } : {}) });
    }
    if (!(options.operator === 'or' ? matched.size > 0 : matched.size === patterns.length))
        return undefined;
    // Equal title values can be persisted with different provenance; show the snippet once.
    const excerpts = [...new Set(fields.flatMap((field) => field.excerpts))].slice(0, 3);
    return {
        index: doc.index, turn: 0, kind: doc.kind, excerpt: excerpts.join(' … '), fields,
        ...(doc.timestamp ? { timestamp: doc.timestamp } : {}),
        ...(doc.toolName ? { toolName: doc.toolName } : {}),
        ...(doc.locator ? { locator: doc.locator } : {}),
        ...(doc.callId ? { callId: doc.callId } : {}),
        ...(doc.artifactPath ? { artifactPath: doc.artifactPath } : {}),
    };
}
function fieldRank(match) {
    if (match.fields?.some((field) => field.field === 'title' || field.field.startsWith('title.')))
        return 0;
    if (match.fields?.some((field) => ['text', 'tool_name', 'tool_args', 'artifact_name', 'artifact_path'].includes(field.field)))
        return 1;
    return 2;
}
function timeOf(match) {
    const at = Date.parse(match.timestamp ?? '');
    return Number.isFinite(at) ? at : 0;
}
function compare(a, b, options) {
    return (options.sort === 'time' ? 0 : fieldRank(a) - fieldRank(b)) || timeOf(b) - timeOf(a) || a.index - b.index || (a.artifactPath ?? '').localeCompare(b.artifactPath ?? '');
}
function buildHit(ref, docs, starts, patterns, options) {
    const matches = [];
    const candidates = [];
    let suppressed = 0;
    const echo = echoFolder(Date.now());
    for (const doc of docs) {
        // Observe all tool events before matching, so a query prefilter cannot hide its own invocation.
        const folded = doc.kind !== 'metadata' && doc.kind !== 'artifact' && echo({ index: doc.index, kind: doc.kind, timestamp: doc.timestamp, body: Object.values(doc.fields).filter(Boolean).join('\n') });
        if (doc.kind !== 'metadata' && doc.kind !== 'artifact' && !kindsOf(options).includes(doc.kind))
            continue;
        if (folded) {
            if (matchDocument(doc, patterns, options))
                suppressed++;
            continue;
        }
        candidates.push(doc);
    }
    // An AND query may span a native call's name, arguments and one or more results.
    const combined = new Map();
    if (patterns.length > 1 && options.operator !== 'or')
        for (const doc of candidates) {
            if (!doc.callId)
                continue;
            const group = combined.get(doc.callId) ?? { ...doc, fields: {} };
            for (const [field, value] of Object.entries(doc.fields))
                group.fields[`${doc.index}.${field}`] = value;
            combined.set(doc.callId, group);
        }
    for (const doc of candidates) {
        const group = doc.callId ? combined.get(doc.callId) : undefined;
        if (group && !matchDocument(group, patterns, options))
            continue;
        const match = matchDocument(doc, patterns, group ? { ...options, operator: 'or' } : options);
        if (!match)
            continue;
        match.turn = match.index >= 0 ? turnNoAt(starts, match.index) : 0;
        if (!match.timestamp && ref.updatedAt) {
            match.timestamp = ref.updatedAt;
            match.timeSource = 'session';
        }
        else if (match.timestamp)
            match.timeSource = 'event';
        matches.push(match);
    }
    if (!matches.length && !suppressed)
        return undefined;
    matches.sort((a, b) => compare(a, b, options));
    const caller = options.selfSessionId ?? process.env.SESSION_READER_CALLER_SESSION;
    return { session: ref, matches, totalMatches: matches.length, ...(suppressed ? { suppressed } : {}),
        ...(isCallerSession(ref, caller) || (!matches.length && suppressed > 0) ? { self: true } : {}) };
}
/** Fetches only the selected session when an ID is supplied; no full-provider sweep. */
export async function searchSessions(query, options = {}) {
    if (!query.trim())
        throw new Error('search query must not be empty');
    if (options.area && !['dialogue', 'tools', 'artifacts', 'all'].includes(options.area))
        throw new Error('area must be dialogue, tools, artifacts, or all');
    if (options.operator && !['and', 'or'].includes(options.operator))
        throw new Error('operator must be and or or');
    if (options.sort && !['relevance', 'time'].includes(options.sort))
        throw new Error('sort must be relevance or time');
    if (options.terms && (!Array.isArray(options.terms) || options.terms.some((term) => typeof term !== 'string')))
        throw new Error('terms must be an array of strings');
    for (const [name, value] of [['limit', options.limit], ['maxPerSession', options.maxPerSession]])
        if (value !== undefined && value !== Infinity && (!Number.isInteger(value) || value < 1))
            throw new Error(`${name} must be a positive integer`);
    const terms = options.terms?.length ? options.terms : [query];
    if (terms.some((term) => !term.trim()))
        throw new Error('search terms must not be empty');
    if (options.regex && options.terms?.length)
        throw new Error('regex and literal terms cannot be combined');
    const patterns = terms.map((term) => buildPattern(term, options));
    const direct = options.useIndex === false || process.env.SESSION_READER_NO_INDEX === '1';
    const hits = direct ? await searchByParsing(options, patterns) : await searchByIndex(options, patterns);
    hits.sort((a, b) => {
        const bestA = a.matches[0];
        const bestB = b.matches[0];
        return (bestA && bestB ? compare(bestA, bestB, options) : bestA ? -1 : bestB ? 1 : 0)
            || `${a.session.provider}:${a.session.id}`.localeCompare(`${b.session.provider}:${b.session.id}`);
    });
    const visible = hits.filter((hit) => !hit.self);
    const revision = createHash('sha256').update(JSON.stringify(visible.map((hit) => [hit.session.provider, hit.session.id, hit.totalMatches, hit.matches.map((match) => [match.locator ?? match.index, match.timestamp, match.fields, match.excerpt])]))).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify({ query, terms, area: options.area, kinds: options.kinds, regex: options.regex, case: options.caseSensitive, operator: options.operator, sort: options.sort, session: options.sessionId, workspace: options.workspace, provider: options.provider, since: options.since, revision })).digest('hex');
    let sessionOffset = 0;
    let matchOffset = 0;
    if (options.cursor) {
        try {
            const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
            if (cursor.key !== fingerprint || !Number.isInteger(cursor.session) || !Number.isInteger(cursor.match) || cursor.session < 0 || cursor.match < 0)
                throw new Error();
            sessionOffset = cursor.session;
            matchOffset = cursor.match;
        }
        catch {
            throw new Error('invalid search cursor, changed query, or search results changed');
        }
    }
    const cursorFor = (session, match) => Buffer.from(JSON.stringify({ key: fingerprint, session, match })).toString('base64url');
    const cap = Math.max(1, Math.min(options.maxPerSession ?? DEFAULT_MAX_PER_SESSION, HARD_CAP));
    const selected = visible.slice(sessionOffset, sessionOffset + (options.limit ?? visible.length));
    for (let i = 0; i < selected.length; i++) {
        const hit = selected[i];
        const offset = i === 0 ? matchOffset : 0;
        hit.matches = hit.matches.slice(offset, offset + cap);
        const groups = new Map();
        for (const match of hit.matches) {
            const key = match.callId ? `call:${match.callId}` : `${match.turn}:${match.kind === 'metadata' || match.kind === 'artifact' ? match.artifactPath ?? match.kind : ''}`;
            const group = groups.get(key) ?? { turn: match.turn, ...(match.callId ? { callId: match.callId } : {}), matches: [] };
            group.matches.push(match);
            groups.set(key, group);
        }
        hit.groups = [...groups.values()];
        hit.hasMore = offset + hit.matches.length < hit.totalMatches;
        if (hit.hasMore)
            hit.nextCursor = cursorFor(sessionOffset + i, offset + hit.matches.length);
        else if (i === selected.length - 1 && sessionOffset + selected.length < visible.length)
            hit.nextCursor = cursorFor(sessionOffset + selected.length, 0);
    }
    // Preserve the existing self-hit reporting contract.
    return [...selected, ...hits.filter((hit) => hit.self).map((hit) => ({ ...hit, matches: hit.matches.slice(0, cap) }))];
}
async function searchByParsing(options, patterns) {
    const { resolveSession } = await import('./resolver.js');
    const target = options.sessionId ? await resolveSession(options.sessionId, options.provider) : undefined;
    if (options.sessionId && !target)
        throw new Error(`session not found: ${options.sessionId}`);
    const handles = target ? [target] : await listResolvedSessions({ ...options, limit: Infinity, scan: Infinity });
    const hits = [];
    const kinds = new Set(kindsOf(options));
    for (const handle of handles) {
        const session = await handle.adapter.parse(handle.candidate);
        if (options.workspace && !isInside(canonicalizePath(options.workspace), session.ref.workspace ?? ''))
            continue;
        const docs = [...session.turns.filter((event) => kinds.has(event.kind) || kinds.has('tool_result') && event.kind === 'tool_call').map(eventDocument), ...metadataDocuments(session.ref, session.artifacts, options)];
        const hit = buildHit(session.ref, docs, turnStarts(session), patterns, options);
        if (hit)
            hits.push(hit);
    }
    return hits;
}
async function searchByIndex(options, patterns) {
    const { openStore } = await import('./store/db.js');
    const { refreshSession } = await import('./store/indexer.js');
    const { searchRows } = await import('./store/rows.js');
    const { refOf, turnStartsOf, findSessionRow } = await import('./store/read.js');
    const { indexedHandle, resolveSession } = await import('./resolver.js');
    const db = await openStore();
    const ids = [];
    const sinceMs = parseSince(options.since);
    if (options.sessionId) {
        const row = findSessionRow(db, options.sessionId);
        const target = (row && row.id.toLowerCase() === options.sessionId.toLowerCase() ? await indexedHandle(row) : undefined) ?? await resolveSession(options.sessionId, options.provider);
        if (!target)
            throw new Error(`session not found: ${options.sessionId}`);
        ids.push((await refreshSession(db, target, { edges: false })).id);
    }
    else {
        for (const adapter of adapters) {
            if (options.provider && adapter.provider !== options.provider)
                continue;
            for (const candidate of await adapter.listCandidates()) {
                if (sinceMs && candidate.mtimeMs < sinceMs)
                    break;
                if (options.workspace && adapter.workspaceOf?.(candidate) && !isInside(canonicalizePath(options.workspace), adapter.workspaceOf(candidate)))
                    continue;
                ids.push((await refreshSession(db, { adapter, candidate }, { edges: false })).id);
            }
        }
    }
    const kinds = kindsOf(options);
    const docs = new Map();
    const prefilter = patterns.length > 1 || patterns[0].source.includes('\0')
        ? {} : planQuery(patterns[0].source, { regex: true, caseSensitive: options.caseSensitive });
    // Seed the echo folder independently of the keyword prefilter.
    if (kinds.includes('tool_result'))
        for (const row of searchRows(db, { ids, kinds: ['tool_call'], literal: '1session ' })) {
            const list = docs.get(row.session_id) ?? [];
            list.push({ index: row.idx, kind: 'tool_call', timestamp: row.ts ?? undefined, fields: { tool_args: row.tool_args_json ?? undefined } });
            docs.set(row.session_id, list);
        }
    if (kinds.length)
        for (const row of searchRows(db, { ids, workspace: options.workspace ? canonicalizePath(options.workspace) : undefined, kinds, ...prefilter })) {
            const list = docs.get(row.session_id) ?? [];
            list.push({ index: row.idx, kind: row.kind, timestamp: row.ts ?? undefined,
                toolName: row.tool_name ?? undefined, locator: row.locator ?? undefined, callId: row.call_id ?? undefined,
                fields: { text: row.text ?? undefined, tool_name: row.tool_name ?? undefined, tool_args: row.tool_args_json ?? undefined, tool_result: row.tool_result ?? undefined }, });
            docs.set(row.session_id, list);
        }
    const hits = [];
    for (const id of ids) {
        const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
        if (!row)
            continue;
        const ref = refOf(row);
        if (options.workspace && !isInside(canonicalizePath(options.workspace), ref.workspace ?? ''))
            continue;
        if (options.provider && ref.provider !== options.provider)
            continue;
        const artifacts = row.artifacts_json ? JSON.parse(row.artifacts_json) : [];
        const events = (docs.get(id) ?? []).sort((a, b) => a.index - b.index);
        const unique = [...new Map(events.map((doc) => [doc.index, doc])).values()];
        const documents = [...unique, ...metadataDocuments(ref, artifacts, options)];
        const hit = buildHit(ref, documents, turnStartsOf(db, id, row.event_count), patterns, options);
        if (hit)
            hits.push(hit);
    }
    return hits;
}
