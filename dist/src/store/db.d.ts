import type { DatabaseSync } from 'node:sqlite';
/** Where the index lives. `SESSION_READER_DB` overrides it (tests, CI). */
export declare function defaultDbPath(): string;
export declare function isIndexWriteError(error: unknown): boolean;
/** Permission failures disable the cache for this read, never the source files. */
export declare function tryIndex<T>(read: () => Promise<T>): Promise<T | undefined>;
/**
 * Opens the version-isolated index without destructive migration. The handle is cached per path so a single
 * CLI run never opens the file twice.
 */
export declare function openStore(dbPath?: string): Promise<DatabaseSync>;
/** Unknown/newer/older populated stores belong to their original reader. Never erase them. */
export declare function assertStoreSchema(db: DatabaseSync, dbPath: string): void;
/** Test hook — forgets the cached handle so a new path can be opened. */
export declare function resetStoreCache(): void;
