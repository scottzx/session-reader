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
    return path.join(os.homedir(), '.1agents', 'session-reader', 'index.db');
}
let cached;
let cachedPath;
/**
 * Opens (and migrates) the index. The handle is cached per path so a single
 * CLI run never opens the file twice.
 */
export async function openStore(dbPath = defaultDbPath()) {
    if (cached && cachedPath === dbPath)
        return cached;
    const { DatabaseSync: Sqlite } = await importSqlite();
    if (dbPath !== ':memory:')
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    let db = new Sqlite(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    if (schemaVersionOf(db) !== SCHEMA_VERSION) {
        db = rebuild(db, Sqlite, dbPath);
    }
    db.exec(DDL);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    cached = db;
    cachedPath = dbPath;
    return db;
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
/**
 * A DDL change invalidates every derived row, and L0 can rebuild all of it, so
 * starting from an empty file beats writing migration code for a cache.
 */
function rebuild(db, Sqlite, dbPath) {
    const hadTables = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'").get().c > 0;
    if (!hadTables)
        return db;
    db.close();
    if (dbPath !== ':memory:') {
        for (const suffix of ['', '-wal', '-shm'])
            fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    const fresh = new Sqlite(dbPath);
    fresh.exec('PRAGMA journal_mode = WAL');
    fresh.exec('PRAGMA synchronous = NORMAL');
    fresh.exec('PRAGMA busy_timeout = 5000');
    return fresh;
}
/** Test hook — forgets the cached handle so a new path can be opened. */
export function resetStoreCache() {
    cached = undefined;
    cachedPath = undefined;
}
