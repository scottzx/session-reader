import type { DatabaseSync } from 'node:sqlite';
import type { NormalizedSession, TurnEvent } from '../types.js';
/**
 * How one session relates to another. Only the two we can prove today are
 * emitted; the rest are reserved so the vocabulary does not get invented
 * twice, and are never guessed from coincidence.
 */
export type EdgeRelation = 'references' | 'handoff_from' | 'forked_from' | 'resumed_from' | 'sends_to';
export interface EdgeCandidate {
    relation: EdgeRelation;
    target: string;
    eventIndex: number;
    operation: string;
    command: string;
    timestamp?: string;
}
/** Reads the session-reader invocations out of one tool call. */
export declare function invocationsOf(event: TurnEvent): EdgeCandidate[];
/**
 * Derives L3 for one session from its stored events. Targets that do not
 * resolve to an indexed session are dropped — a dangling edge is worse than
 * no edge.
 */
export declare function deriveEdges(db: DatabaseSync, id: string, session: NormalizedSession): number;
/**
 * Records an edge at the moment it happens, when the caller session is known.
 * Injected by a hook or the ACP context as `SESSION_READER_CALLER_SESSION`;
 * absent everywhere else, in which case nothing is written.
 */
export declare function captureRuntimeEdge(db: DatabaseSync, verb: string, target: string, 
/**
 * Who is doing the reading. Defaults to the CLI's injected caller; `1session
 * serve` passes the `X-Caller-Session` header instead, so one process can
 * serve several callers without going through the environment.
 */
callerId?: string | undefined): void;
export interface EdgeView {
    from: string;
    to: string;
    relation: EdgeRelation;
    evidenceCount: number;
    firstSeenAt?: string;
    lastSeenAt?: string;
    direction: 'out' | 'in';
}
export declare function edgesOf(db: DatabaseSync, id: string): EdgeView[];
export declare function edgeEvidence(db: DatabaseSync, from: string, to: string, relation: string): {
    eventIndex: number;
    operation: string;
    ts?: string;
    extractor: string;
}[];
