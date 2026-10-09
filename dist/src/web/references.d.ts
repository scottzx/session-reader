import type { SessionRef } from '../types.js';
export declare function sessionKey(session: Pick<SessionRef, 'provider' | 'id'>): string;
/** A portable reference for an agent; visible turn numbers are only navigation aids. */
export declare function agentReference(session: SessionRef, target?: {
    locator?: string;
    callId?: string;
    artifactPath?: string;
    excerpt?: string;
}): string;
