import { selectSession } from '../identity.js';
import { decodeText } from './nul.js';
import { turnStartsFrom } from '../turns.js';
import { emptyProviderStats, } from '../types.js';
export function sessionRow(db, id) {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}
/** Resolves a full id, an id prefix, or a native id against the index. */
export function findSessionRow(db, needle) {
    const lower = needle.toLowerCase();
    const colon = lower.indexOf(':');
    const provider = colon >= 0 ? lower.slice(0, colon) : undefined;
    const native = colon >= 0 ? lower.slice(colon + 1) : lower;
    const exact = db.prepare('SELECT * FROM sessions WHERE lower(id) = ? OR (lower(native_id) = ? AND (? IS NULL OR provider = ?))').all(lower, native, provider ?? null, provider ?? null);
    if (exact.length)
        return selectSession(exact, needle);
    if (native.length < 6)
        return undefined;
    const rows = db.prepare('SELECT * FROM sessions WHERE substr(lower(native_id), 1, ?) = ? AND (? IS NULL OR provider = ?)').all(native.length, native, provider ?? null, provider ?? null);
    return selectSession(rows, needle);
}
/**
 * The listing served from the index: newest first, no scan budget, so a
 * workspace never silently loses its older sessions to a candidate cap.
 */
export function listSessionRows(db, query) {
    const where = [];
    const params = [];
    if (query.ids) {
        if (!query.ids.length)
            return [];
        db.exec('DROP TABLE IF EXISTS temp.list_scope');
        db.exec('CREATE TEMP TABLE list_scope (id TEXT PRIMARY KEY)');
        const insert = db.prepare('INSERT OR IGNORE INTO temp.list_scope (id) VALUES (?)');
        for (const id of query.ids)
            insert.run(id);
        where.push('id IN (SELECT id FROM temp.list_scope)');
    }
    if (query.workspace) {
        // Prefix comparison rather than LIKE: real paths contain `_`, a LIKE wildcard.
        where.push('(workspace = ? OR substr(workspace, 1, ?) = ?)');
        params.push(query.workspace, query.workspace.length + 1, `${query.workspace}/`);
    }
    if (query.provider) {
        where.push('provider = ?');
        params.push(query.provider);
    }
    if (query.sinceMs) {
        where.push('source_mtime_ms >= ?');
        params.push(query.sinceMs);
    }
    params.push(query.limit ?? 20);
    const sql = `SELECT * FROM sessions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
        // Undated rows sort last instead of first, which is where DESC puts NULL.
        'ORDER BY (ended_at IS NULL), ended_at DESC LIMIT ?';
    return db.prepare(sql).all(...params);
}
/**
 * Turn starts for one indexed session, without rebuilding it.
 *
 * The rule has to stay the rule `turnStarts` applies to a parsed session — a
 * user event carrying real text opens a turn — so the two are fed to the same
 * `turnStartsFrom`; only the source of the indices differs.
 */
export function turnStartsOf(db, sessionId, eventCount) {
    const rows = db
        .prepare(`SELECT idx FROM events
        WHERE session_id = ? AND kind = 'user' AND trim(coalesce(text, '')) != ''
        ORDER BY idx`)
        .all(sessionId);
    return turnStartsFrom(rows.map((row) => row.idx), eventCount);
}
export function refOf(row) {
    return {
        id: row.native_id,
        provider: row.provider,
        path: row.source_path,
        ...(row.title === null ? {} : { title: decodeText(row.title) }),
        ...(row.workspace === null ? {} : { workspace: row.workspace }),
        ...(row.started_at === null ? {} : { createdAt: row.started_at }),
        ...(row.ended_at === null ? {} : { updatedAt: row.ended_at }),
        sizeBytes: row.source_size,
        ...(row.ref_json ? JSON.parse(row.ref_json) : {}),
    };
}
/**
 * Rebuilds events exactly as the parser emitted them — absent optionals stay
 * absent, so the result deep-equals a fresh `parse()`.
 */
export function eventsOf(db, id, nativeId, from = 0, to = Number.MAX_SAFE_INTEGER) {
    const rows = db
        .prepare('SELECT * FROM events WHERE session_id = ? AND idx BETWEEN ? AND ? ORDER BY idx')
        .all(id, from, to);
    return rows.map((row) => ({
        id: `${nativeId}#${row.idx}`,
        index: row.idx,
        kind: row.kind,
        ...(row.text === null ? {} : { text: decodeText(row.text) }),
        ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
        ...(row.tool_args_json === null
            ? {}
            : { toolArgs: JSON.parse(row.tool_args_json) }),
        ...(row.tool_result === null ? {} : { toolResult: decodeText(row.tool_result) }),
        ...(row.is_error === null ? {} : { isError: row.is_error === 1 }),
        ...(row.ts === null ? {} : { timestamp: row.ts }),
        ...(row.source_index === null ? {} : { sourceIndex: row.source_index }),
        ...(row.provider_truncated === null ? {} : { truncated: row.provider_truncated === 1 }),
        ...(row.pid === null ? {} : { processId: row.pid }),
        ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        ...(row.locator === null ? {} : { locator: row.locator }),
        ...(row.call_id === null ? {} : { callId: row.call_id }),
        ...(row.full_text === null ? {} : { fullText: decodeText(row.full_text) }),
        ...(row.extra_json ? JSON.parse(row.extra_json) : {}),
    }));
}
export function readSession(db, row) {
    const artifacts = row.artifacts_json
        ? JSON.parse(row.artifacts_json)
        : [];
    const stats = row.stats_json
        ? JSON.parse(row.stats_json)
        : emptyProviderStats();
    return {
        ref: refOf(row),
        turns: eventsOf(db, row.id, row.native_id),
        artifacts,
        stats,
    };
}
