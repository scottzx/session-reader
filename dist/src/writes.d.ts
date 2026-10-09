import type { Provenance, TurnEvent } from './types.js';
export interface FileWrite {
    path: string;
    /** `observed` from a dedicated edit tool, `derived` from a shell command. */
    provenance: Provenance;
    /** The rule that produced it: `tool:Write`, `shell:redirect`, … */
    extractor: string;
    /** Set when the write happened inside `ssh user@host '…'`. */
    host?: string;
    event?: number;
}
/**
 * Drops here-document bodies before scanning. Their content is data being
 * written, not commands — and when the payload is source code, its arrow
 * functions and string literals otherwise masquerade as redirects and hosts.
 */
export declare function stripHeredocs(command: string): string;
/** The untruncated shell command a tool call carries, if it is a shell tool. */
export declare function rawCommand(turn: TurnEvent): string | undefined;
/**
 * The command as it should be analysed: here-doc payloads removed, so that
 * data being written never gets mistaken for commands being run.
 */
export declare function analyzableCommand(turn: TurnEvent): string | undefined;
/**
 * Files a single tool call wrote. Explicit writes come from dedicated edit
 * tools; inferred ones are parsed out of shell commands (heuristic — agents
 * that write through the shell would otherwise leave no trace at all).
 */
export declare function fileWrites(turn: TurnEvent): FileWrite[];
/**
 * Stable identity for a write: `host:path` when remote, otherwise an absolute
 * local path (relative ones resolved against the session's workspace).
 */
export declare function resolveWritePath(write: FileWrite, workspace?: string): string;
