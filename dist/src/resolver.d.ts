import type { ProviderAdapter, SessionCandidate } from './parsers/provider.js';
import type { AgentProvider, NormalizedSession, SessionRef } from './types.js';
export declare const adapters: ProviderAdapter[];
export interface ListOptions {
    limit?: number;
    /**
     * Serve the listing from the index (the default). The sweep still checks
     * every session file's fingerprint, but only the ones whose bytes moved are
     * parsed again — so a listing is complete regardless of `scan`, and cheap
     * after the first run. Set false to read the source files directly.
     */
    useIndex?: boolean;
    /**
     * When true (default), fingerprint-sweep every on-disk candidate so the
     * listing is complete and fresh. Set false to query the index only — no
     * parse, no all-files sweep. The DSH panel uses this so opening it does
     * not load every session; click a row to load that one.
     */
    refresh?: boolean;
    /**
     * How many session files may be opened. Defaults to a small budget so an
     * unfiltered `list` stays cheap; pass `Infinity` when completeness matters
     * more than latency (indexing, search).
     */
    scan?: number;
    workspace?: string;
    provider?: AgentProvider;
    /** Only sessions updated at or after this moment (`24h`, `7d`, ISO date). */
    since?: string | Date;
}
export interface ResolvedSession {
    ref: SessionRef;
    adapter: ProviderAdapter;
    candidate: SessionCandidate;
}
/** Accepts `24h`, `90m`, `7d`, `2026-09-01` or a Date. */
export declare function parseSince(since: string | Date | undefined): number | undefined;
/** Discovery that keeps the adapter handle, so callers can parse without a second scan. */
export declare function listResolvedSessions(options?: ListOptions): Promise<ResolvedSession[]>;
export declare function listRecentSessions(options?: ListOptions): Promise<SessionRef[]>;
export declare function findSessionsByWorkspace(workspacePath: string, options?: Omit<ListOptions, 'workspace'>): Promise<SessionRef[]>;
export declare function findResolvedByWorkspace(workspacePath: string, options?: Omit<ListOptions, 'workspace'>): Promise<ResolvedSession[]>;
/** Locates a session by full id, id prefix, or native file path. */
export declare function resolveSession(sessionId: string, provider?: AgentProvider): Promise<ResolvedSession | undefined>;
export declare function parseSession(sessionId: string): Promise<NormalizedSession>;
export interface LoadOptions {
    /** Set false to bypass the index entirely (CI, read-only checkouts). */
    useIndex?: boolean;
    force?: boolean;
}
/**
 * The one seam every command loads sessions through. Whether the events come
 * from the index or straight off disk, the object handed back is the same, so
 * `buildOverview` / `fileLedger` / `summarizeTurns` never learn about caching.
 */
export declare function loadSession(sessionId: string, options?: LoadOptions): Promise<NormalizedSession>;
/** Reuses the indexed file path without enumerating providers. */
export declare function indexedHandle(row: {
    provider: string;
    native_id: string;
    source_path: string;
}): Promise<{
    adapter: ProviderAdapter;
    candidate: SessionCandidate;
} | undefined>;
