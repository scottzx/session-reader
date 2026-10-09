import { selectSession } from './identity.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { antigravityAdapter } from './parsers/antigravity.js';
import { claudeAdapter } from './parsers/claude.js';
import { codexAdapter } from './parsers/codex.js';
import { dshAdapter, dshTranscriptPath } from './parsers/dsh.js';
import { grokAdapter } from './parsers/grok.js';
import { canonicalizePath, isInside, slugifyWorkspace } from './util/paths.js';
export const adapters = [
    antigravityAdapter,
    claudeAdapter,
    codexAdapter,
    dshAdapter,
    grokAdapter,
];
/** How many files we are willing to open when nothing narrows the search. */
const DEFAULT_SCAN = 60;
/** A workspace filter rejects most candidates, so it needs a wider net. */
const WORKSPACE_SCAN = 600;
/** Accepts `24h`, `90m`, `7d`, `2026-09-01` or a Date. */
export function parseSince(since) {
    if (!since)
        return undefined;
    if (since instanceof Date)
        return since.getTime();
    const relative = /^(\d+)\s*([hdmw])$/i.exec(since.trim());
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2].toLowerCase();
        const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit] ?? 0;
        return Date.now() - amount * ms;
    }
    const parsed = Date.parse(since);
    return Number.isNaN(parsed) ? undefined : parsed;
}
function matchesWorkspace(ref, workspace) {
    if (!ref.workspace)
        return false;
    return isInside(workspace, ref.workspace);
}
/**
 * Whether a file can possibly belong to the workspace, judged from its path
 * alone. Only ever used to skip an open, so it must never reject a session it
 * is unsure about: Claude's slug is lossy (`-` stands for several characters),
 * Grok's percent-encoded directory is exact, everyone else says "maybe".
 */
function couldBelong(candidate, adapter, workspace) {
    const exact = adapter.workspaceOf?.(candidate);
    if (exact)
        return isInside(workspace, exact);
    if (adapter.provider !== 'claude')
        return true;
    const slug = slugifyWorkspace(workspace);
    const dir = path.basename(path.dirname(candidate.path));
    return dir === slug || dir.startsWith(`${slug}-`);
}
/** Discovery that keeps the adapter handle, so callers can parse without a second scan. */
export async function listResolvedSessions(options = {}) {
    const limit = options.limit ?? 20;
    // `/` contains every session by definition, so filtering on it would only
    // cost a scan and drop the sessions whose cwd we could not recover.
    const scoped = options.workspace ? canonicalizePath(options.workspace) : undefined;
    const workspace = scoped && scoped !== '/' ? scoped : undefined;
    const sinceMs = parseSince(options.since);
    const found = [];
    for (const adapter of adapters) {
        if (options.provider && adapter.provider !== options.provider)
            continue;
        const candidates = await adapter.listCandidates();
        let scanned = 0;
        const budget = options.scan ?? (workspace ? WORKSPACE_SCAN : DEFAULT_SCAN);
        for (const candidate of candidates) {
            if (sinceMs && candidate.mtimeMs < sinceMs)
                break; // candidates are newest first
            if (scanned >= budget)
                break;
            if (workspace && !couldBelong(candidate, adapter, workspace))
                continue;
            scanned++;
            const ref = await adapter.scanRef(candidate).catch(() => undefined);
            if (!ref)
                continue;
            if (workspace && !matchesWorkspace(ref, workspace))
                continue;
            found.push({ ref, adapter, candidate });
        }
    }
    return found
        .sort((a, b) => Date.parse(b.ref.updatedAt ?? '') - Date.parse(a.ref.updatedAt ?? ''))
        .slice(0, limit);
}
export async function listRecentSessions(options = {}) {
    if (options.useIndex === false || process.env.SESSION_READER_NO_INDEX === '1') {
        return (await listResolvedSessions(options)).map((session) => session.ref);
    }
    return listIndexedSessions(options);
}
/**
 * The listing as the index sees it: a fingerprint sweep over every candidate
 * (cheap once indexed), then one SQL query. Unlike the scanning path this one
 * has no candidate budget, so a workspace never quietly loses its older
 * sessions once a provider grows past `WORKSPACE_SCAN` files.
 */
async function listIndexedSessions(options) {
    const { openStore } = await import('./store/db.js');
    const { refreshSession } = await import('./store/indexer.js');
    const { listSessionRows, refOf } = await import('./store/read.js');
    const db = await openStore();
    const sinceMs = parseSince(options.since);
    const scoped = options.workspace ? canonicalizePath(options.workspace) : undefined;
    const query = {
        ...(scoped && scoped !== '/' ? { workspace: scoped } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(sinceMs ? { sinceMs } : {}),
        limit: options.limit ?? 20,
    };
    // Skip the all-files fingerprint sweep: the caller only wants whatever
    // the index already knows. Used by the DSH panel's lazy listing.
    if (options.refresh === false) {
        return listSessionRows(db, query).map(refOf);
    }
    const ids = [];
    for (const adapter of adapters) {
        if (options.provider && adapter.provider !== options.provider)
            continue;
        for (const candidate of await adapter.listCandidates()) {
            if (sinceMs && candidate.mtimeMs < sinceMs)
                break; // candidates are newest first
            const result = await refreshSession(db, { adapter, candidate }, { edges: false }).catch(() => undefined);
            if (result)
                ids.push(result.id);
        }
    }
    return listSessionRows(db, { ids, ...query }).map(refOf);
}
export async function findSessionsByWorkspace(workspacePath, options = {}) {
    return listRecentSessions({ ...options, limit: options.limit ?? 50, workspace: workspacePath });
}
export async function findResolvedByWorkspace(workspacePath, options = {}) {
    return listResolvedSessions({ ...options, limit: options.limit ?? 50, workspace: workspacePath });
}
/** Locates a session by full id, id prefix, or native file path. */
export async function resolveSession(sessionId, provider) {
    const asPath = sessionId.includes('/') ? canonicalizePath(sessionId) : undefined;
    const handles = [];
    for (const adapter of adapters) {
        if (provider && adapter.provider !== provider)
            continue;
        for (const candidate of await adapter.listCandidates())
            handles.push({ adapter, candidate });
    }
    const chosen = asPath
        ? handles.find((handle) => handle.candidate.path === asPath)
        : selectSession(handles.map((handle) => ({ ...handle, provider: handle.adapter.provider, native_id: handle.candidate.id, id: `${handle.adapter.provider}:${handle.candidate.id}` })), sessionId);
    if (!chosen)
        return undefined;
    return { adapter: chosen.adapter, candidate: chosen.candidate, ref: await chosen.adapter.scanRef(chosen.candidate) };
}
export async function parseSession(sessionId) {
    const resolved = await resolveSession(sessionId);
    if (!resolved)
        throw new Error(`session not found: ${sessionId}`);
    return resolved.adapter.parse(resolved.candidate);
}
/**
 * The one seam every command loads sessions through. Whether the events come
 * from the index or straight off disk, the object handed back is the same, so
 * `buildOverview` / `fileLedger` / `summarizeTurns` never learn about caching.
 */
export async function loadSession(sessionId, options = {}) {
    if (options.useIndex === false || process.env.SESSION_READER_NO_INDEX === '1') {
        return parseSession(sessionId);
    }
    const { openStore } = await import('./store/db.js');
    const { findSessionRow } = await import('./store/read.js');
    const { indexSession } = await import('./store/indexer.js');
    const db = await openStore();
    // A session the index already knows can be re-checked with a single stat,
    // instead of walking every provider directory again.
    const row = findSessionRow(db, sessionId);
    const handle = (row && row.id.toLowerCase() === sessionId.toLowerCase() ? await indexedHandle(row) : undefined)
        ?? (await resolveSession(sessionId));
    if (!handle)
        throw new Error(`session not found: ${sessionId}`);
    const result = await indexSession(db, handle, { ...(options.force ? { force: true } : {}) });
    return result.session;
}
/** Rebuilds an adapter handle from an indexed row without a directory scan. */
async function handleFromPath(provider, nativeId, sourcePath) {
    const adapter = adapters.find((item) => item.provider === provider);
    if (!adapter)
        return undefined;
    const stat = await fs.stat(sourcePath).catch(() => undefined);
    if (!stat)
        return undefined;
    return {
        adapter,
        candidate: { id: nativeId, path: sourcePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size },
    };
}
/** Reuses the indexed file path without enumerating providers. */
export async function indexedHandle(row) {
    if (row.provider === 'dsh') {
        const current = await dshTranscriptPath(path.dirname(row.source_path));
        return current ? handleFromPath(row.provider, row.native_id, current) : undefined;
    }
    return handleFromPath(row.provider, row.native_id, row.source_path);
}
