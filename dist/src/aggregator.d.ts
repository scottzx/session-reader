import type { DigestFocus, WorkspaceDigest } from './types.js';
export interface AggregateOptions {
    since?: string | Date;
    /** Maximum number of sessions to open and interleave. */
    limit?: number;
    focus?: DigestFocus;
}
/**
 * Pulls every session that ran in `workspacePath` — regardless of which agent
 * produced it — and interleaves them into a single project storyline.
 */
export declare function aggregateWorkspaceSessions(workspacePath: string, options?: AggregateOptions): Promise<WorkspaceDigest>;
