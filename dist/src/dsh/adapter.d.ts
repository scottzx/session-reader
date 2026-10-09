import type { NormalizedSession } from '../types.js';
export interface DshSessionEvent {
    type: string;
    seq: number;
    time: number;
    surfaceOp?: 'append';
    data: Record<string, unknown>;
}
export interface ConvertOptions {
    /** Initial sequence number, defaults to 0 (DSH 0-based sequence convention). */
    startSeq?: number;
}
/**
 * Converts a normalized session from @1agents/session-reader (across Claude, Codex,
 * Antigravity, Grok, or DSH) into an ordered sequence of DSH SessionEvents suitable
 * for direct ingestion and rendering by DSH Client UI (@deepseek-ai/dsh-client-ui-chat).
 */
export declare function convertSessionToDshEvents(session: NormalizedSession, options?: ConvertOptions): DshSessionEvent[];
