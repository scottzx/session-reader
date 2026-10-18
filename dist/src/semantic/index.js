import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmbeddingClient, embeddingProfile } from '@1agents/artifact-index/embeddings';
import { importSqlite } from '../util/sqlite.js';
import { assertStoreSchema, defaultDbPath } from '../store/db.js';
import { refOf, turnStartsOf } from '../store/read.js';
import { decodeText, encodeText } from '../store/nul.js';
import { parseSince } from '../resolver.js';
import { selectSession } from '../identity.js';
import { isCallerSession } from '../search.js';
import { canonicalizePath, isInside } from '../util/paths.js';
import { turnNoAt } from '../turns.js';
import { CHUNKER, chunkText, hash } from './chunks.js';
const VERSION = '1';
export const semanticDbPath = () => process.env.SESSION_READER_SEMANTIC_DB || path.join(os.homedir(), '.1agents', 'session-reader', 'semantic-v1.db');
const fail = (code, message) => Object.assign(new Error(message), { code });
const scopeKey = (o) => hash([o.workspace ? canonicalizePath(o.workspace) : null, o.provider ?? null, o.sessionId ?? null, o.since ?? null]);
const aliasOf = (model) => {
    if (model !== undefined && model !== 'qwen3' && model !== 'embeddinggemma2')
        throw fail('SEMANTIC_INVALID_QUERY', 'model must be qwen3 or embeddinggemma2');
    return model ?? 'qwen3';
};
const fingerprint = (row) => hash([row.id, row.source_path, row.workspace, row.title, row.source_size, row.source_mtime_ms, row.head_hash, row.aux_fingerprint, row.parser_version, row.event_count, row.ref_json]);
const clientFor = (o) => o.client ?? createEmbeddingClient({ agent: process.env.SESSION_READER_EMBEDDING_GATEWAY || 'http://127.0.0.1:36908' });
/** Read only the current structural snapshot; no implicit source scan or expensive refresh. */
async function sources(o, text) {
    const file = o.sourceDbPath ?? defaultDbPath();
    if (!fs.existsSync(file))
        throw fail('SEMANTIC_SOURCE_REQUIRED', 'Structural index is missing. Run 1session index <id> or index --all in the desired scope first.');
    const { DatabaseSync: Sqlite } = await importSqlite();
    const db = new Sqlite(file, { readOnly: true });
    try {
        assertStoreSchema(db, file);
        const since = parseSince(o.since);
        if (o.since !== undefined && (since === undefined || !Number.isFinite(since)))
            throw fail('SEMANTIC_INVALID_QUERY', 'Invalid since filter');
        if (o.provider !== undefined && !['claude', 'codex', 'grok', 'dsh', 'antigravity', 'cursor', 'unknown'].includes(o.provider))
            throw fail('SEMANTIC_INVALID_QUERY', 'Unknown provider');
        db.exec('BEGIN');
        const workspace = o.workspace ? canonicalizePath(o.workspace) : undefined;
        let rows = db.prepare('SELECT * FROM sessions ORDER BY id').all().filter(row => (!workspace || workspace === '/' || (row.workspace !== null && isInside(workspace, row.workspace))) &&
            (!o.provider || row.provider === o.provider) && (since === undefined || row.source_mtime_ms >= since));
        if (o.sessionId) {
            const chosen = o.sessionId.includes('/') ? rows.find(row => row.source_path === canonicalizePath(o.sessionId)) : selectSession(rows, o.sessionId);
            rows = chosen ? [chosen] : [];
        }
        const out = [];
        for (const row of rows) {
            const where = "session_id = ? AND kind IN ('user', 'assistant') AND length(trim(coalesce(full_text,text,''))) > 0";
            const count = db.prepare(`SELECT count(*) AS total, sum(CASE WHEN locator IS NOT NULL AND locator != '' THEN 1 ELSE 0 END) AS eligible FROM events WHERE ${where}`).get(row.id);
            const source = { row, ref: refOf(row), fingerprint: fingerprint(row), eventCount: count.eligible ?? 0, skipped: count.total - (count.eligible ?? 0), chunks: [] };
            if (text) {
                const starts = turnStartsOf(db, row.id, row.event_count);
                const events = db.prepare(`SELECT idx, kind, locator, ts, coalesce(full_text,text) AS text FROM events WHERE ${where} AND locator IS NOT NULL AND locator != '' ORDER BY idx`).all(row.id);
                for (const event of events)
                    for (const chunk of chunkText(decodeText(event.text))) {
                        source.chunks.push({ ...chunk, sessionId: row.id, id: hash([row.id, event.locator, chunk.start, chunk.end]), index: event.idx, turn: turnNoAt(starts, event.idx), kind: event.kind, locator: event.locator, timestamp: event.ts });
                    }
            }
            out.push(source);
        }
        db.exec('COMMIT');
        return out;
    }
    finally {
        db.close();
    }
}
const DDL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, profile_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vectors(profile_id TEXT NOT NULL, text_hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(profile_id,text_hash));
CREATE TABLE IF NOT EXISTS indexed_sources(profile_id TEXT NOT NULL, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, event_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL, built_at TEXT NOT NULL, PRIMARY KEY(profile_id,session_id));
CREATE TABLE IF NOT EXISTS chunks(profile_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL, locator TEXT NOT NULL, event_idx INTEGER NOT NULL, turn_no INTEGER NOT NULL, kind TEXT NOT NULL, timestamp TEXT, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, text_hash TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(profile_id,session_id,id));
CREATE INDEX IF NOT EXISTS chunk_sources ON chunks(profile_id,session_id);
CREATE TABLE IF NOT EXISTS builds(id TEXT PRIMARY KEY, model TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, target_chunks INTEGER NOT NULL DEFAULT 0, encoded_vectors INTEGER NOT NULL DEFAULT 0, reused_vectors INTEGER NOT NULL DEFAULT 0, error_code TEXT);
`;
function schema(db) {
    const count = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get();
    if (!count.n)
        return;
    let version;
    try {
        version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
    }
    catch { /* unknown store */ }
    if (version !== VERSION)
        throw fail('SEMANTIC_SCHEMA_MISMATCH', 'Unknown semantic database schema. Refusing to modify it; select a different SESSION_READER_SEMANTIC_DB.');
    const chunker = db.prepare("SELECT value FROM meta WHERE key='chunker'").get()?.value;
    if (chunker !== CHUNKER)
        throw fail('SEMANTIC_SCHEMA_MISMATCH', 'Unknown semantic chunker. Refusing to modify it; choose a new semantic database.');
}
async function store(file, write) {
    const { DatabaseSync: Sqlite } = await importSqlite();
    if (fs.existsSync(file) && fs.statSync(file).size) {
        const probe = new Sqlite(file, { readOnly: true });
        try {
            schema(probe);
        }
        finally {
            probe.close();
        }
    }
    else if (!write)
        return undefined;
    if (write)
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new Sqlite(file, { readOnly: !write });
    try {
        schema(db);
        if (write) {
            fs.chmodSync(file, 0o600);
            db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
            db.exec(DDL);
            db.prepare("INSERT OR IGNORE INTO meta VALUES('schema_version', ?)").run(VERSION);
            db.prepare("INSERT OR IGNORE INTO meta VALUES('chunker', ?)").run(CHUNKER);
        }
        const chunker = db.prepare("SELECT value FROM meta WHERE key='chunker'").get()?.value;
        if (chunker !== CHUNKER)
            throw fail('SEMANTIC_SCHEMA_MISMATCH', 'Chunker changed. Build a separate semantic database before switching.');
        return db;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
function activeProfile(db, model) {
    if (!db)
        return null;
    const row = db.prepare('SELECT p.profile_json FROM profiles p JOIN meta m ON m.value=p.id WHERE m.key=?').get(`active:${model}`);
    return row ? embeddingProfile(JSON.parse(row.profile_json)) : null;
}
function status(db, selected, o) {
    const model = aliasOf(o.model), profile = activeProfile(db, model);
    let indexedSessions = 0, indexedEvents = 0, indexedChunks = 0, updatedAt = null;
    if (db && profile)
        for (const source of selected) {
            const row = db.prepare('SELECT * FROM indexed_sources WHERE profile_id=? AND session_id=?').get(profile.id, source.row.id);
            if (row?.fingerprint !== source.fingerprint)
                continue;
            indexedSessions++;
            indexedEvents += row.event_count;
            indexedChunks += row.chunk_count;
            if (!updatedAt || row.built_at > updatedAt)
                updatedAt = row.built_at;
        }
    const totalEvents = selected.reduce((n, s) => n + s.eventCount, 0), skippedEvents = selected.reduce((n, s) => n + s.skipped, 0);
    const pendingEvents = Math.max(0, totalEvents - indexedEvents);
    const lastBuild = db?.prepare('SELECT status,started_at,finished_at,target_chunks,encoded_vectors,reused_vectors,error_code FROM builds WHERE model=? AND scope=? ORDER BY started_at DESC,rowid DESC LIMIT 1').get(model, scopeKey(o));
    return { mode: 'semantic', model, profile, chunker: CHUNKER, coverageBasis: 'structural-index-snapshot', rawSourceDiscovery: false, totalSessions: selected.length, indexedSessions, totalEvents, pendingEvents, skippedEvents, indexedChunks, partial: pendingEvents > 0 || skippedEvents > 0 || indexedSessions < selected.length, updatedAt, lastBuild: lastBuild ?? null };
}
export async function semanticStatus(o = {}) {
    const selected = await sources(o, false);
    const db = await store(o.dbPath ?? semanticDbPath(), false);
    try {
        return status(db, selected, o);
    }
    finally {
        db?.close();
    }
}
function checked(result, profile, count) {
    if (embeddingProfile(result.profile).id !== profile.id || !Array.isArray(result.vectors) || result.vectors.length !== count)
        throw fail('SEMANTIC_PROFILE_MISMATCH', 'Embedding response does not match the indexed profile or count');
    for (const vector of result.vectors) {
        if (!Array.isArray(vector) || vector.length !== profile.dimensions || vector.some(n => !Number.isFinite(n)) || Math.abs(vector.reduce((n, v) => n + v * v, 0) - 1) > 0.01)
            throw fail('SEMANTIC_PROFILE_MISMATCH', 'Embedding response contains invalid vectors');
    }
    return result.vectors;
}
function blob(vector) { const b = Buffer.alloc(vector.length * 4); vector.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; }
/** One lease for all mutations; canonical paths also serialize symlink aliases. */
function writerLock(input) {
    let file = path.resolve(input);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    file = fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    const lock = `${file}.build.lock`;
    try {
        fs.mkdirSync(lock, { mode: 0o700 });
    }
    catch (error) {
        if (error.code === 'EEXIST')
            throw fail('SEMANTIC_BUILD_BUSY', 'Another semantic writer owns the build lock. A crashed-writer lock requires explicit operator recovery.');
        throw error;
    }
    try {
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    }
    catch (error) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
    }
    return { file, release: () => fs.rmSync(lock, { recursive: true, force: true }) };
}
/** Explicit local eviction across model profiles. Does not remove or change source transcripts. */
export async function forgetSemanticSession(sessionId, options = {}) {
    if (!/^[a-z]+:[^/\s:]+$/.test(sessionId))
        throw fail('SEMANTIC_INVALID_QUERY', 'forget requires the complete canonical provider:session-id, never a prefix or path');
    const input = options.dbPath ?? semanticDbPath();
    if (!fs.existsSync(input))
        return { sessionId, removedChunks: 0 };
    const lease = writerLock(input);
    let db;
    try {
        db = await store(lease.file, true);
        db.exec('BEGIN IMMEDIATE');
        try {
            const count = db.prepare('SELECT count(*) AS n FROM chunks WHERE session_id=?').get(sessionId);
            db.prepare('DELETE FROM chunks WHERE session_id=?').run(sessionId);
            db.prepare('DELETE FROM indexed_sources WHERE session_id=?').run(sessionId);
            db.prepare('DELETE FROM vectors WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.profile_id=vectors.profile_id AND c.text_hash=vectors.text_hash)').run();
            db.exec('COMMIT');
            return { sessionId, removedChunks: count.n };
        }
        catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    finally {
        db?.close();
        lease.release();
    }
}
/** Incremental encoding and atomic activation; failed batches leave the last generation intact. */
export async function buildSemanticIndex(o = {}) {
    const model = aliasOf(o.model), sourceFile = path.resolve(o.sourceDbPath ?? defaultDbPath());
    let file = path.resolve(o.dbPath ?? semanticDbPath());
    const resolved = (p) => fs.existsSync(p) ? fs.realpathSync(p) : p;
    if (resolved(file) === resolved(sourceFile))
        throw fail('SEMANTIC_SCHEMA_MISMATCH', 'Semantic and structural databases must use different paths');
    const lease = writerLock(file);
    file = lease.file;
    let db;
    const id = randomUUID();
    let encodedVectors = 0, reusedVectors = 0;
    try {
        db = await store(file, true);
        const started = new Date().toISOString();
        db.prepare('INSERT INTO builds(id,model,scope,status,started_at) VALUES(?,?,?,?,?)').run(id, model, scopeKey(o), 'running', started);
        const selected = await sources(o, true);
        if (!selected.length)
            throw fail('SEMANTIC_SOURCE_REQUIRED', 'No indexed sessions match this scope; refresh the structural index or adjust scope first');
        const client = clientFor(o);
        if (model !== 'qwen3' && !client.embedDocuments)
            throw fail('SEMANTIC_CLIENT_UPGRADE_REQUIRED', 'Gemma document indexing requires the updated shared embedding client with embedDocuments; published 0.1.0 supports Qwen here.');
        o.signal?.throwIfAborted();
        const profile = embeddingProfile(await (client.getTextProfile ? client.getTextProfile(model, { signal: o.signal }) : client.getProfile('text', { signal: o.signal })));
        if (profile.alias !== model)
            throw fail('SEMANTIC_PROFILE_MISMATCH', 'Selected model differs from requested model');
        const window = /:max(\d+):/.exec(profile.encoding);
        if (!window || Number(window[1]) < 512)
            throw fail('SEMANTIC_PROFILE_MISMATCH', 'Provider window is smaller than this chunker supports');
        db.prepare('INSERT OR IGNORE INTO profiles VALUES(?,?)').run(profile.id, JSON.stringify(profile));
        const chunks = selected.flatMap(s => s.chunks), unique = new Map(chunks.map(c => [c.textHash, c.text]));
        const pending = [];
        for (const pair of unique) {
            if (db.prepare('SELECT 1 FROM vectors WHERE profile_id=? AND text_hash=?').get(profile.id, pair[0]))
                reusedVectors++;
            else
                pending.push(pair);
        }
        db.prepare('UPDATE builds SET target_chunks=?,reused_vectors=? WHERE id=?').run(chunks.length, reusedVectors, id);
        for (let i = 0; i < pending.length; i += 16) {
            o.signal?.throwIfAborted();
            const batch = pending.slice(i, i + 16), texts = batch.map(x => x[1]);
            const result = client.embedDocuments ? await client.embedDocuments(texts, profile, { signal: o.signal }) : await client.embedText(texts, { inputType: 'document', signal: o.signal });
            const vectors = checked(result, profile, batch.length);
            db.exec('BEGIN IMMEDIATE');
            try {
                const insert = db.prepare('INSERT OR IGNORE INTO vectors VALUES(?,?,?)');
                batch.forEach(([key], j) => insert.run(profile.id, key, blob(vectors[j])));
                encodedVectors += batch.length;
                db.prepare('UPDATE builds SET encoded_vectors=? WHERE id=?').run(encodedVectors, id);
                db.exec('COMMIT');
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        }
        o.signal?.throwIfAborted();
        const current = await sources(o, false);
        if (hash(current.map(s => [s.row.id, s.fingerprint])) !== hash(selected.map(s => [s.row.id, s.fingerprint])))
            throw fail('SEMANTIC_SOURCE_CHANGED', 'Structural snapshot changed during encoding; retry to reuse completed vectors');
        const finished = new Date().toISOString();
        db.exec('BEGIN IMMEDIATE');
        try {
            const insert = db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
            for (const source of selected) {
                db.prepare('DELETE FROM chunks WHERE profile_id=? AND session_id=?').run(profile.id, source.row.id);
                for (const c of source.chunks)
                    insert.run(profile.id, c.sessionId, c.id, c.locator, c.index, c.turn, c.kind, c.timestamp, c.start, c.end, c.textHash, encodeText(c.text));
                db.prepare('INSERT OR REPLACE INTO indexed_sources VALUES(?,?,?,?,?,?)').run(profile.id, source.row.id, source.fingerprint, source.eventCount, source.chunks.length, finished);
            }
            db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(`active:${model}`, profile.id);
            db.prepare('UPDATE builds SET status=?,finished_at=? WHERE id=?').run('completed', finished, id);
            db.exec('COMMIT');
        }
        catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        return { ...status(db, selected, o), encodedVectors, reusedVectors };
    }
    catch (error) {
        if (db)
            try {
                db.prepare('UPDATE builds SET status=?,finished_at=?,error_code=? WHERE id=?').run('failed', new Date().toISOString(), String(error.code ?? 'SEMANTIC_BUILD_FAILED'), id);
            }
            catch { /* schema/open failure */ }
        throw error;
    }
    finally {
        db?.close();
        lease.release();
    }
}
function queryOptions(o) {
    if (o.regex || o.caseSensitive || o.terms !== undefined || o.operator !== undefined || o.cursor !== undefined || (o.sort && o.sort !== 'relevance') || (o.area && o.area !== 'dialogue') || (o.kinds && (!o.kinds.length || o.kinds.some(k => k !== 'user' && k !== 'assistant'))) || o.useIndex === false || o.refresh === true) {
        throw fail('SEMANTIC_INVALID_QUERY', 'Semantic search supports indexed dialogue only; regex, case, terms/operator, cursor, time sort, refresh and --no-index are not supported.');
    }
    for (const n of [o.limit ?? 20, o.maxPerSession ?? 5])
        if (!Number.isSafeInteger(n) || n < 1)
            throw fail('SEMANTIC_INVALID_QUERY', 'limit and maxPerSession must be positive integers');
}
export async function searchSemanticSessions(query, o = {}) {
    queryOptions(o);
    aliasOf(o.model);
    if (typeof query !== 'string' || !query.trim())
        throw fail('SEMANTIC_INVALID_QUERY', 'search query must not be empty');
    if (Buffer.byteLength(query) > 320)
        throw fail('SEMANTIC_INVALID_QUERY', 'Semantic query exceeds the conservative 320-byte UTF-8 budget; shorten the question.');
    let selected = await sources(o, false);
    const file = o.dbPath ?? semanticDbPath();
    let db = await store(file, false), expected;
    try {
        const p = activeProfile(db, aliasOf(o.model));
        if (!p)
            throw fail('SEMANTIC_INDEX_REQUIRED', 'No active semantic index for this model; run 1session index build --semantic first');
        expected = p;
    }
    finally {
        db?.close();
    }
    // No SQLite transaction is held over network I/O.
    const vector = checked(await clientFor(o).embedQuery(query, expected, { signal: o.signal }), expected, 1)[0];
    selected = await sources(o, false);
    db = await store(file, false);
    try {
        db?.exec('BEGIN');
        if (activeProfile(db, aliasOf(o.model))?.id !== expected.id)
            throw fail('SEMANTIC_SOURCE_CHANGED', 'Active vector space changed during query; retry');
        const retrieval = status(db, selected, o), candidates = [];
        const caller = o.selfSessionId ?? process.env.SESSION_READER_CALLER_SESSION;
        for (const source of selected) {
            if (!o.includeSelf && isCallerSession(source.ref, caller))
                continue;
            const indexed = db.prepare('SELECT * FROM indexed_sources WHERE profile_id=? AND session_id=?').get(expected.id, source.row.id);
            if (indexed?.fingerprint !== source.fingerprint)
                continue;
            const matches = [];
            const rows = db.prepare('SELECT c.*,v.vector FROM chunks c JOIN vectors v ON c.profile_id=v.profile_id AND c.text_hash=v.text_hash WHERE c.profile_id=? AND c.session_id=? ORDER BY c.event_idx,c.start_offset').iterate(expected.id, source.row.id);
            for (const raw of rows) {
                const row = raw;
                if (o.kinds && !o.kinds.includes(row.kind))
                    continue;
                const bytes = Buffer.from(row.vector);
                if (bytes.length !== expected.dimensions * 4)
                    throw fail('SEMANTIC_PROFILE_MISMATCH', 'Corrupt stored vector dimension');
                let score = 0;
                for (let i = 0; i < vector.length; i++)
                    score += vector[i] * bytes.readFloatLE(i * 4);
                if (!Number.isFinite(score))
                    throw fail('SEMANTIC_PROFILE_MISMATCH', 'Corrupt stored vector');
                matches.push({ score, match: { index: row.event_idx, turn: row.turn_no, kind: row.kind, locator: row.locator, excerpt: decodeText(row.text), ...(row.timestamp ? { timestamp: row.timestamp } : {}), timeSource: row.timestamp ? 'event' : 'session', similarity: score, chunkRange: [row.start_offset, row.end_offset] } });
            }
            matches.sort((a, b) => b.score - a.score || a.match.index - b.match.index);
            const seen = new Set();
            const distinct = matches.filter(x => { if (seen.has(x.match.locator))
                return false; seen.add(x.match.locator); return true; });
            const top = distinct.slice(0, o.maxPerSession ?? 5);
            if (top.length)
                candidates.push({ source, score: top[0].score, matches: top.map(x => x.match), totalMatches: distinct.length });
        }
        candidates.sort((a, b) => b.score - a.score || a.source.row.id.localeCompare(b.source.row.id));
        const hits = candidates.slice(0, o.limit ?? 20).map(c => ({ session: c.source.ref, matches: c.matches, totalMatches: c.totalMatches, hasMore: c.totalMatches > c.matches.length, score: c.score, self: isCallerSession(c.source.ref, caller) }));
        return { hits, retrieval };
    }
    finally {
        db?.close();
    }
}
