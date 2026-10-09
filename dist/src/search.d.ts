import { type ListOptions } from './resolver.js';
import type { SessionRef, TurnKind } from './types.js';
export interface SearchOptions extends ListOptions {
    /** Bypass the index and parse every candidate from disk. */
    useIndex?: boolean;
    /** Restrict to these event kinds; defaults to user and assistant dialogue. */
    kinds?: TurnKind[];
    /** Treat the query as a regular expression instead of a literal. */
    regex?: boolean;
    caseSensitive?: boolean;
    /** Characters of context kept around each match. */
    context?: number;
    /** Matches recorded per session before scanning moves on. */
    maxPerSession?: number;
    /**
     * The session doing the searching, so its own live transcript can be marked.
     * Defaults to `SESSION_READER_CALLER_SESSION`; pass `''` to disable.
     */
    selfSessionId?: string;
    area?: 'dialogue' | 'tools' | 'artifacts' | 'all';
    sessionId?: string;
    /** Explicit literal terms; query remains one literal unless these are supplied. */
    terms?: string[];
    operator?: 'and' | 'or';
    sort?: 'relevance' | 'time';
    cursor?: string;
}
export interface SearchMatch {
    index: number;
    /**
     * The turn this event belongs to — the other half of the drill-down handle,
     * so `T<turn> · E<index>` maps straight onto `turn <id> <turn> --event <index>`.
     * 0 when the session records no turn that contains the event.
     */
    turn: number;
    kind: TurnKind | 'metadata' | 'artifact';
    toolName?: string;
    timestamp?: string;
    excerpt: string;
    fields?: {
        field: string;
        ranges: [number, number][];
        excerpts: string[];
        hasMoreRanges?: true;
    }[];
    locator?: string;
    callId?: string;
    artifactPath?: string;
    timeSource?: 'event' | 'session';
}
export interface SearchHit {
    session: SessionRef;
    matches: SearchMatch[];
    totalMatches: number;
    groups?: {
        turn: number;
        callId?: string;
        matches: SearchMatch[];
    }[];
    hasMore?: boolean;
    nextCursor?: string;
    /** Matches dropped because they were this very search echoing back. */
    suppressed?: number;
    /**
     * The searcher's own session: either the injected caller id, or a session
     * whose every match was the running invocation. Never removed from the
     * result — callers hide it, so the count stays reportable.
     */
    self?: boolean;
}
/**
 * A substring that every string matching `source` must contain, or `undefined`
 * when no such substring can be proven.
 *
 * Deliberately timid: alternation or groups anywhere and it gives up. A
 * prefilter that is merely usually right would hand back "searched everything"
 * answers that quietly missed rows — the exact failure this store exists to
 * remove — so "no literal" is always the safe reply.
 */
export declare function mandatoryLiteral(source: string): string | undefined;
export interface QueryPlan {
    literal?: string;
    fold?: boolean;
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
export declare function planQuery(query: string, options?: SearchOptions): QueryPlan;
export interface Candidate {
    index: number;
    kind: TurnKind;
    toolName?: string;
    timestamp?: string;
    body: string;
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
export declare function echoFolder(now: number): (candidate: Candidate) => boolean;
/**
 * Whether a session is the one running the search. Accepts the canonical
 * `provider:native_id`, the bare native id, or a 6+ character prefix of it —
 * the same spellings `resolveSession` takes.
 */
export declare function isCallerSession(ref: SessionRef, callerId: string | undefined): boolean;
/** Fetches only the selected session when an ID is supplied; no full-provider sweep. */
export declare function searchSessions(query: string, options?: SearchOptions): Promise<SearchHit[]>;
