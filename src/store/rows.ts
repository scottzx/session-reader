import type { DatabaseSync } from 'node:sqlite';

/** One indexed event, reduced to the columns a text search needs. */
export interface TextRow {
  session_id: string;
  idx: number;
  kind: string;
  tool_name: string | null;
  ts: string | null;
  text: string | null;
  tool_result: string | null;
  tool_args_json: string | null;
}

export interface RowQuery {
  /** Sessions in scope, already refreshed against disk. */
  ids: string[];
  /** Canonical workspace root; matches the directory itself and everything under it. */
  workspace?: string;
  kinds?: string[];
  /**
   * A substring every match must contain. Pushing it into SQL is only sound
   * when it is genuinely mandatory — see `mandatoryLiteral` in `search.ts`.
   */
  literal?: string;
  /** Compare the literal case-insensitively (ASCII folding, as SQLite does). */
  fold?: boolean;
}

const TEXT_COLUMNS = ['text', 'tool_result', 'tool_args_json'] as const;

/**
 * Streams candidate rows. The filters are structural — session scope,
 * workspace, kind — plus an optional literal prefilter; deciding whether a row
 * really matches stays with the regex matcher, which remains the only
 * authority on search semantics.
 */
export function* searchRows(db: DatabaseSync, query: RowQuery): Generator<TextRow> {
  if (!query.ids.length) return;

  db.exec('DROP TABLE IF EXISTS temp.search_scope');
  db.exec('CREATE TEMP TABLE search_scope (id TEXT PRIMARY KEY)');
  const insert = db.prepare('INSERT OR IGNORE INTO temp.search_scope (id) VALUES (?)');
  for (const id of query.ids) insert.run(id);

  const where: string[] = [];
  const params: (string | number)[] = [];

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
    const column = (name: string) =>
      query.fold ? `lower(coalesce(e.${name}, ''))` : `coalesce(e.${name}, '')`;
    // Per column, never across the joined haystack: a literal that straddles
    // two fields would be missed, so callers reject literals containing a
    // newline before they get here.
    where.push(`(${TEXT_COLUMNS.map((name) => `instr(${column(name)}, ?) > 0`).join(' OR ')})`);
    params.push(...TEXT_COLUMNS.map(() => query.literal!));
  }

  const sql =
    `SELECT e.session_id, e.idx, e.kind, e.tool_name, e.ts, e.text, e.tool_result, e.tool_args_json
     FROM events e
     JOIN temp.search_scope sc ON sc.id = e.session_id
     JOIN sessions s ON s.id = e.session_id` +
    (where.length ? `\n     WHERE ${where.join(' AND ')}` : '') +
    '\n     ORDER BY e.session_id, e.idx';

  try {
    yield* db.prepare(sql).iterate(...params) as unknown as Generator<TextRow>;
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.search_scope');
  }
}

/** Session rows for the ids a search ended up with. */
export function scopedSessions(db: DatabaseSync, ids: string[]) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`SELECT * FROM sessions WHERE id IN (${placeholders})`).all(...ids);
}
