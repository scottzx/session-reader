import type { DatabaseSync } from 'node:sqlite';
import { type NormalizedSession, type SessionRef, type TurnEvent } from '../types.js';
export interface SessionRow {
    id: string;
    provider: string;
    native_id: string;
    source_path: string;
    workspace: string | null;
    title: string | null;
    started_at: string | null;
    ended_at: string | null;
    event_count: number;
    turn_count: number;
    source_size: number;
    source_mtime_ms: number;
    head_hash: string | null;
    aux_fingerprint: string | null;
    parser_version: number;
    extractor_version: number;
    edge_version: number;
    indexed_at: string | null;
    artifacts_json: string | null;
    stats_json: string | null;
    ref_json: string | null;
}
export declare function sessionRow(db: DatabaseSync, id: string): SessionRow | undefined;
/** Resolves a full id, an id prefix, or a native id against the index. */
export declare function findSessionRow(db: DatabaseSync, needle: string): SessionRow | undefined;
export interface ListQuery {
    /**
     * Ids seen on disk during this sweep; rows outside it are stale and skipped.
     * Omit to list from the whole index (lazy UI listings that skip the sweep).
     * An explicit empty array still means "nothing in scope".
     */
    ids?: string[];
    /** Canonical root; matches the directory itself and everything under it. */
    workspace?: string;
    provider?: string;
    sinceMs?: number;
    limit?: number;
}
/**
 * The listing served from the index: newest first, no scan budget, so a
 * workspace never silently loses its older sessions to a candidate cap.
 */
export declare function listSessionRows(db: DatabaseSync, query: ListQuery): SessionRow[];
/**
 * Turn starts for one indexed session, without rebuilding it.
 *
 * The rule has to stay the rule `turnStarts` applies to a parsed session — a
 * user event carrying real text opens a turn — so the two are fed to the same
 * `turnStartsFrom`; only the source of the indices differs.
 */
export declare function turnStartsOf(db: DatabaseSync, sessionId: string, eventCount: number): number[];
export declare function refOf(row: SessionRow): SessionRef;
/**
 * Rebuilds events exactly as the parser emitted them — absent optionals stay
 * absent, so the result deep-equals a fresh `parse()`.
 */
export declare function eventsOf(db: DatabaseSync, id: string, nativeId: string, from?: number, to?: number): TurnEvent[];
export declare function readSession(db: DatabaseSync, row: SessionRow): NormalizedSession;
