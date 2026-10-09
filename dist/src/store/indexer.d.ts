import type { DatabaseSync } from 'node:sqlite';
import type { ProviderAdapter, SessionCandidate } from '../parsers/provider.js';
import type { NormalizedSession } from '../types.js';
export type IndexAction = 'indexed' | 'reused' | 'facts-rederived' | 'edges-rederived';
export interface IndexResult {
    id: string;
    action: IndexAction;
    session: NormalizedSession;
}
export interface IndexHandle {
    adapter: ProviderAdapter;
    candidate: SessionCandidate;
}
export interface IndexOptions {
    /** Re-read the source even when the fingerprint says nothing changed. */
    force?: boolean;
    /** Skip L3 — a bulk backfill derives edges once at the end instead. */
    edges?: boolean;
}
export interface RefreshResult {
    id: string;
    action: IndexAction;
    /** Present only when the work required materializing it anyway. */
    session?: NormalizedSession;
}
/**
 * Brings one session's index up to date and returns it.
 *
 * The three layers are invalidated independently: only a changed fingerprint
 * or a new `PARSER_VERSION` costs a file read. A new `EXTRACTOR_VERSION` or
 * `EDGE_VERSION` re-derives from the stored events alone.
 */
export declare function indexSession(db: DatabaseSync, handle: IndexHandle, options?: IndexOptions): Promise<IndexResult>;
/**
 * The same work without materializing the session.
 *
 * A caller that only needs the index to be current — search, for one — pays a
 * stat and a 64KB read per session instead of rebuilding every event object.
 */
export declare function refreshSession(db: DatabaseSync, handle: IndexHandle, options?: IndexOptions): Promise<RefreshResult>;
