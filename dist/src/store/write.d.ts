import type { DatabaseSync } from 'node:sqlite';
import type { AgentProvider, NormalizedSession } from '../types.js';
import type { SessionCandidate } from '../parsers/provider.js';
/** Store key. `SessionRef.id` stays the provider-native id, untouched. */
export declare function canonicalId(provider: AgentProvider, nativeId: string): string;
export interface Fingerprint {
    sourceSize: number;
    sourceMtimeMs: number;
    headHash: string;
    auxFingerprint?: string;
}
/**
 * Identity of the bytes we parsed. JSONL is append-only in practice, so a
 * matching head hash rules out the one case size+mtime cannot: a rewrite that
 * happens to land on the same length.
 */
export declare function fingerprintOf(candidate: SessionCandidate, aux?: string): Fingerprint;
/**
 * Replaces the L1 rows of one session. Everything derived from it (L2, L3) is
 * dropped in the same transaction, so the database is never half-new.
 */
export declare function writeSession(db: DatabaseSync, session: NormalizedSession, fingerprint: Fingerprint, turnCount: number): string;
