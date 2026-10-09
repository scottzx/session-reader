import type { ProviderAdapter } from './provider.js';
/**
 * The folder a trajectory was opened in, out of the IDE's own metadata blob.
 *
 * Field 1.1 is that folder as a `file://` URI (1.2 holds the enclosing
 * workspace root when the two differ, 1.4 the git branch). Sessions started
 * with no folder open — the IDE labels them `outside-of-project` — carry no
 * field 1 at all, and an unknown workspace is the honest answer for them.
 */
export declare function workspaceFromTrajectoryBlob(data: Uint8Array): string | undefined;
export declare const antigravityAdapter: ProviderAdapter;
/** Antigravity shortens long step output in the transcript; this is the full copy. */
export declare function readFullStepOutput(transcriptPath: string, stepIndex: number): Promise<string | undefined>;
