import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importSqlite } from '../util/sqlite.js';
import { DDL, SCHEMA_VERSION } from './schema.js';
/** Where the index lives. `SESSION_READER_DB` overrides it (tests, CI). */
export function defaultDbPath() {
    const override = process.env.SESSION_READER_DB;
    if (override)
        return override;
    return path.join(os.homedir(), '.1agents', 'session-reader', `index-v${SCHEMA_VERSION}.db`);
}
let cached;
let cachedPath;
export function isIndexWriteError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const { code, errcode, path: denied } = error;
    if (['EACCES', 'EPERM', 'EROFS'].includes(code ?? '')) {
        if (!denied)
            return true;
        const dbPath = path.resolve(defaultDbPath());
        const target = path.resolve(denied);
        return ['', '-wal', '-shm'].some((suffix) => target === `${dbPath}${suffix}`)
            || `${path.dirname(dbPath)}${path.sep}`.startsWith(`${target}${path.sep}`);
    }
    return ['SQLITE_PERM', 'SQLITE_READONLY', 'SQLITE_CANTOPEN'].includes(code ?? '')
        // SQLite extended result codes keep the primary code in the low byte.
        || (typeof errcode === 'number' && [3, 8, 14].includes(errcode & 0xff));
}
/** Permission failures disable the cache for this read, never the source files. */
export async function tryIndex(read) {
    try {
        return await read();
    }
    catch (error) {
        if (!isIndexWriteError(error))
            throw error;
        console.warn('1session: index is not writable; reading raw session files instead (slower).');
        return undefined;
    }
}
/**
 * Opens the version-isolated index without destructive migration. The handle is cached per path so a single
 * CLI run never opens the file twice.
 */
export async function openStore(dbPath = defaultDbPath()) {
    if (cached && cachedPath === dbPath)
        return cached;
    const { DatabaseSync: Sqlite } = await importSqlite();
    if (dbPath !== ':memory:')
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // Check existing databases read-only before any journal mode or DDL write.
    if (dbPath !== ':memory:' && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
        const probe = new Sqlite(dbPath, { readOnly: true });
        try {
            assertStoreSchema(probe, dbPath);
        }
        finally {
            probe.close();
        }
    }
    const db = new Sqlite(dbPath);
    try {
        assertStoreSchema(db, dbPath);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec(DDL);
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
        cached = db;
        cachedPath = dbPath;
        return db;
    }
    catch (error) {
        try {
            db.close();
        }
        catch { /* preserve the opening error */ }
        throw error;
    }
}
function schemaVersionOf(db) {
    try {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        return row?.value ? Number(row.value) : undefined;
    }
    catch {
        return undefined; // no meta table yet — a fresh file
    }
}
/** Unknown/newer/older populated stores belong to their original reader. Never erase them. */
export function assertStoreSchema(db, dbPath) {
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
    const version = schemaVersionOf(db);
    if (tables.n > 0 && version !== SCHEMA_VERSION) {
        throw Object.assign(new Error(`Index schema mismatch at ${dbPath}: expected ${SCHEMA_VERSION}, found ${version ?? 'unknown'}. Refusing to modify it; use a new SESSION_READER_DB path.`), { code: 'INDEX_SCHEMA_MISMATCH' });
    }
}
/** Test hook — forgets the cached handle so a new path can be opened. */
export function resetStoreCache() {
    cached = undefined;
    cachedPath = undefined;
}
