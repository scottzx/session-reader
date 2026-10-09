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
    locator: string | null;
    call_id: string | null;
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
/**
 * Streams candidate rows. The filters are structural — session scope,
 * workspace, kind — plus an optional literal prefilter; deciding whether a row
 * really matches stays with the regex matcher, which remains the only
 * authority on search semantics.
 */
export declare function searchRows(db: DatabaseSync, query: RowQuery): Generator<TextRow>;
/** Session rows for the ids a search ended up with. */
export declare function scopedSessions(db: DatabaseSync, ids: string[]): Record<string, import("node:sqlite").SQLOutputValue>[];
