/** Empty lock files are DSH tombstones; only fresh or PID-bearing locks are active. */
export declare const DEFAULT_LOCK_FRESH_MS: number;
export declare const DEFAULT_RETENTION_DAYS = 7;
export interface DshPaths {
    home: string;
    sessionsDir: string;
    archiveDir: string;
    workspaceFile: string;
}
export declare function dshPaths(): DshPaths;
export declare function coldIndexPath(paths?: DshPaths): string;
/** True when a transcript lives under the cold archive root, not the hot tree. */
export declare function isColdArchivePath(p: string, paths?: DshPaths): boolean;
export declare function normalizeDshId(id: string): string;
export declare function storageDshId(id: string): string;
export interface ArchivedEntry {
    /** Native id without the `session-` prefix. */
    sessionId: string;
    /** Directory name in the hot tree, e.g. `session-<uuid>` or `<uuid>`. */
    nativeDir: string;
    /** Workspace directory name as DSH slugified it under `sessions/`. */
    workspaceDir: string;
    originalPath: string;
    archivePath: string;
    archivedAt: string;
    sizeBytes: number;
}
export interface ColdArchiveIndex {
    version: 1;
    entries: ArchivedEntry[];
}
export declare function readColdIndex(paths?: DshPaths): Promise<ColdArchiveIndex>;
export declare function listColdArchive(paths?: DshPaths): Promise<ArchivedEntry[]>;
export interface ArchivePlanItem {
    sessionId: string;
    storageId: string;
    nativeDir: string;
    workspaceDir: string;
    from: string;
    to: string;
    mtimeMs: number;
    sizeBytes: number;
    status: 'eligible' | 'skipped' | 'conflict';
    reason?: string;
}
export interface ArchivePlan {
    dryRun: boolean;
    cutoffMs?: number;
    items: ArchivePlanItem[];
    eligible: ArchivePlanItem[];
    skipped: ArchivePlanItem[];
    bytes: number;
}
export interface ArchiveOptions {
    sessionId?: string;
    /** Age in days measured from the session directory mtime; 0 means all archived sessions. */
    days?: number;
    dryRun?: boolean;
    /** Consider a lock active when refreshed within this many ms. */
    lockFreshMs?: number;
    paths?: DshPaths;
}
/** Read-only preview: creates no directories and changes no DSH state. */
export declare function planArchive(options?: ArchiveOptions): Promise<ArchivePlan>;
export interface ArchiveResult extends ArchivePlan {
    moved: ArchivedEntry[];
    freedBytes: number;
    backupPath?: string;
    indexUpdated: boolean;
}
/** Move eligible directories, then update the index and DSH's archived-id list atomically. */
export declare function archiveSessions(options?: ArchiveOptions): Promise<ArchiveResult>;
export interface RestoreOptions {
    sessionId: string;
    dryRun?: boolean;
    paths?: DshPaths;
}
export interface RestoreResult {
    sessionId: string;
    from: string;
    to: string;
    dryRun: boolean;
    restored: boolean;
    backupPath?: string;
}
/** Migrate one session back to the hot tree and make it visible to DSH again. */
export declare function restoreSession(options: RestoreOptions): Promise<RestoreResult>;
