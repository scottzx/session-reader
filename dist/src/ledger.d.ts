import type { AsyncJob, CommandRecord, FileRecord, JobStatus, NormalizedSession } from './types.js';
/**
 * Every shell command with whatever is known about how it went. Codex records
 * this itself; for the others we pair each call with the result that follows.
 */
export declare function commandLedger(session: NormalizedSession): CommandRecord[];
/**
 * Failed commands, plus whether a similar command later succeeded.
 * A command counts as failed only on a non-zero exit, or on an unknown exit
 * that the provider itself flagged — never merely because stderr had content.
 */
export declare function errorLedger(session: NormalizedSession): CommandRecord[];
/** Background jobs, merged from provider receipts, shell launches and pids. */
export declare function jobLedger(session: NormalizedSession): AsyncJob[];
export declare function jobCounts(jobs: AsyncJob[]): Record<JobStatus, number>;
/** Every file the session wrote, bucketed by what kind of file it is. */
export declare function fileLedger(session: NormalizedSession): FileRecord[];
/** Display helper shared by the CLI: workspace-relative when possible. */
export declare function displayPath(record: FileRecord, workspace: string | undefined): string;
