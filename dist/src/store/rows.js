import { decodeText } from './nul.js';
const TEXT_COLUMNS = ['text', 'tool_result', 'tool_args_json', 'tool_name', 'full_text'];
/**
 * Streams candidate rows. The filters are structural — session scope,
 * workspace, kind — plus an optional literal prefilter; deciding whether a row
 * really matches stays with the regex matcher, which remains the only
 * authority on search semantics.
 */
export function* searchRows(db, query) {
    if (!query.ids.length)
        return;
    db.exec('DROP TABLE IF EXISTS temp.search_scope');
    db.exec('CREATE TEMP TABLE search_scope (id TEXT PRIMARY KEY)');
    const insert = db.prepare('INSERT OR IGNORE INTO temp.search_scope (id) VALUES (?)');
    for (const id of query.ids)
        insert.run(id);
    const where = [];
    const params = [];
    if (query.workspace) {
        // Plain prefix comparison, not LIKE: real paths contain `_`, which LIKE
        // would treat as a wildcard.
        where.push('(s.workspace = ? OR substr(s.workspace, 1, ?) = ?)');
        params.push(query.workspace, query.workspace.length + 1, `${query.workspace}/`);
    }
    if (query.kinds?.length) {
        where.push(`e.kind IN (${query.kinds.map(() => '?').join(', ')})`);
        params.push(...query.kinds);
    }
    if (query.literal) {
        const column = (name) => query.fold ? `lower(coalesce(e.${name}, ''))` : `coalesce(e.${name}, '')`;
        // Per column, never across the joined haystack: a literal that straddles
        // two fields would be missed, so callers reject literals containing a
        // newline before they get here.
        where.push(`(${TEXT_COLUMNS.map((name) => `instr(${column(name)}, ?) > 0`).join(' OR ')})`);
        params.push(...TEXT_COLUMNS.map(() => query.literal));
    }
    const sql = `SELECT e.session_id, e.idx, e.kind, e.tool_name, e.ts, CASE WHEN e.kind IN ('user', 'assistant', 'thinking') THEN coalesce(e.full_text, e.text) ELSE e.text END AS text, CASE WHEN e.kind = 'tool_result' THEN coalesce(e.full_text, e.tool_result) ELSE e.tool_result END AS tool_result, e.tool_args_json, e.locator, e.call_id
     FROM events e
     JOIN temp.search_scope sc ON sc.id = e.session_id
     JOIN sessions s ON s.id = e.session_id` +
        (where.length ? `\n     WHERE ${where.join(' AND ')}` : '') +
        '\n     ORDER BY e.session_id, e.idx';
    try {
        for (const row of db.prepare(sql).iterate(...params))
            yield { ...row, text: row.text === null ? null : decodeText(row.text), tool_result: row.tool_result === null ? null : decodeText(row.tool_result) };
    }
    finally {
        db.exec('DROP TABLE IF EXISTS temp.search_scope');
    }
}
/** Session rows for the ids a search ended up with. */
export function scopedSessions(db, ids) {
    if (!ids.length)
        return [];
    const placeholders = ids.map(() => '?').join(', ');
    return db.prepare(`SELECT * FROM sessions WHERE id IN (${placeholders})`).all(...ids);
}
