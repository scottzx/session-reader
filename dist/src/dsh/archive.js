/**
 * Physical cold archive for native DSH sessions.
 *
 * DSH only hides an archived session by adding its id to
 * `storages/workspace.json`; the transcript directories stay in the hot
 * `sessions/` tree and are still projected by `ApiSessionList.list()`. This
 * module moves eligible directories into `sessions-archive/`, keeps an index
 * of what moved, and can restore them byte-for-byte.
 *
 * Every path is resolved on each call so that `DSH_HOME` / the individual
 * directory overrides (and mocked `os.homedir()` in tests) take effect.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandHome, isInside } from '../util/paths.js';
/** Empty lock files are DSH tombstones; only fresh or PID-bearing locks are active. */
export const DEFAULT_LOCK_FRESH_MS = 10 * 60 * 1000;
export const DEFAULT_RETENTION_DAYS = 7;
/** Active conversations every pwd keeps after a pass; 0 disables the floor. */
export const DEFAULT_KEEP_ACTIVE = 3;
const INDEX_VERSION = 1;
function envPath(name) {
    const value = process.env[name]?.trim();
    return value ? expandHome(value) : undefined;
}
export function dshPaths() {
    const home = envPath('DSH_HOME') ?? path.join(os.homedir(), '.dsh');
    return {
        home,
        sessionsDir: envPath('DSH_SESSIONS_DIR') ?? path.join(home, 'sessions'),
        archiveDir: envPath('DSH_SESSIONS_ARCHIVE_DIR') ?? path.join(home, 'sessions-archive'),
        workspaceFile: envPath('DSH_WORKSPACE_STORAGE') ?? path.join(home, 'storages', 'workspace.json'),
    };
}
export function coldIndexPath(paths = dshPaths()) {
    return path.join(paths.archiveDir, 'index.json');
}
function resolved(p) {
    return path.resolve(expandHome(p));
}
/** True when a transcript lives under the cold archive root, not the hot tree. */
export function isColdArchivePath(p, paths = dshPaths()) {
    return isInside(resolved(paths.archiveDir), resolved(p));
}
export function normalizeDshId(id) {
    return id.startsWith('session-') ? id.slice('session-'.length) : id;
}
export function storageDshId(id) {
    return id.startsWith('session-') ? id : `session-${id}`;
}
export async function readColdIndex(paths = dshPaths()) {
    const raw = await fs.readFile(coldIndexPath(paths), 'utf8').catch(() => undefined);
    if (!raw)
        return { version: INDEX_VERSION, entries: [] };
    const parsed = JSON.parse(raw);
    if (parsed?.version !== INDEX_VERSION || !Array.isArray(parsed.entries)) {
        throw new Error(`unsupported cold archive index: ${coldIndexPath(paths)}`);
    }
    return { version: INDEX_VERSION, entries: parsed.entries };
}
export async function listColdArchive(paths = dshPaths()) {
    const index = await readColdIndex(paths);
    return index.entries
        .filter((entry) => typeof entry.sessionId === 'string' && typeof entry.archivePath === 'string')
        .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}
async function readWorkspaceState(paths) {
    const raw = await fs.readFile(paths.workspaceFile, 'utf8').catch(() => undefined);
    if (!raw)
        return { parsed: {}, raw: undefined, archived: [], pinned: [], grouped: [] };
    const parsed = JSON.parse(raw);
    const global = (parsed?.global ?? {});
    const ids = (key) => Array.isArray(global[key])
        ? global[key].filter((id) => typeof id === 'string') : [];
    const workspaces = (parsed?.tables?.workspaces ?? {});
    const grouped = [];
    for (const workspace of Object.values(workspaces)) {
        const members = workspace?.sessionIds;
        if (!Array.isArray(members))
            continue;
        for (const id of members)
            if (typeof id === 'string')
                grouped.push(id);
    }
    return { parsed, raw, archived: ids('archivedSessionIds'), pinned: ids('pinnedSessionIds'), grouped };
}
async function writeAtomic(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
        await fs.writeFile(tmp, text, 'utf8');
        await fs.rename(tmp, file);
    }
    catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => { });
        throw error;
    }
}
async function dirSize(dir) {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory())
            total += await dirSize(child);
        else if (entry.isFile())
            total += (await fs.stat(child).catch(() => ({ size: 0 }))).size;
    }
    return total;
}
async function isActiveLock(dir, freshMs) {
    const lock = path.join(dir, 'session.lock');
    const stat = await fs.stat(lock).catch(() => undefined);
    if (!stat)
        return false;
    if (Date.now() - stat.mtimeMs < freshMs)
        return true;
    if (stat.size > 0) {
        const text = (await fs.readFile(lock, 'utf8').catch(() => '')).trim();
        const pid = Number(text);
        if (Number.isInteger(pid) && pid > 0) {
            try {
                process.kill(pid, 0);
                return true;
            }
            catch (error) {
                // EPERM still proves the process exists; ESRCH means the pid is stale.
                if (error.code === 'EPERM')
                    return true;
            }
        }
    }
    return false;
}
/** The transcript's last write is the session's real activity; a directory mtime also changes when a lock file is recreated. */
async function lastActivityMs(dir, fallback) {
    let newest = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(entry.name)) {
            newest = Math.max(newest, (await fs.stat(path.join(dir, entry.name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs);
        }
    }
    return newest || fallback;
}
/** Reject anything that could escape the two roots even with a crafted dir name. */
function safeDirName(name) {
    return Boolean(name) && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}
async function plan(options = {}) {
    const paths = options.paths ?? dshPaths();
    const days = options.days ?? DEFAULT_RETENTION_DAYS;
    if (!Number.isFinite(days) || days < 0)
        throw new Error('days must be a non-negative number');
    const keepActive = options.keepActive ?? DEFAULT_KEEP_ACTIVE;
    if (!Number.isInteger(keepActive) || keepActive < 0)
        throw new Error('keepActive must be a non-negative integer');
    const state = await readWorkspaceState(paths);
    const archived = new Set(state.archived.map(normalizeDshId));
    const pinned = new Set(state.pinned.map(normalizeDshId));
    const grouped = new Set(state.grouped.map(normalizeDshId));
    const wanted = options.sessionId ? normalizeDshId(options.sessionId) : undefined;
    // Rule one takes the sessions DSH already hid; rule two sweeps the sessions
    // DSH attached to a workspace. A session in neither set is out of scope.
    if (wanted && !archived.has(wanted) && !grouped.has(wanted)) {
        throw new Error(`session is not archived in DSH and not attached to a workspace: ${options.sessionId}`);
    }
    const index = await readColdIndex(paths);
    const known = new Set(index.entries.map((entry) => normalizeDshId(entry.sessionId)));
    const cutoffMs = days > 0 ? Date.now() - days * 86_400_000 : undefined;
    const items = [];
    const groups = new Map();
    let foundWanted = false;
    const groupOf = (workspaceDir) => {
        const existing = groups.get(workspaceDir);
        if (existing)
            return existing;
        const created = { remaining: 0, candidates: [] };
        groups.set(workspaceDir, created);
        return created;
    };
    for (const workspaceDir of await fs.readdir(paths.sessionsDir).catch(() => [])) {
        if (!safeDirName(workspaceDir))
            continue;
        const workspacePath = path.join(paths.sessionsDir, workspaceDir);
        if (!(await fs.stat(workspacePath).then((stat) => stat.isDirectory()).catch(() => false)))
            continue;
        for (const nativeDir of await fs.readdir(workspacePath).catch(() => [])) {
            if (!safeDirName(nativeDir))
                continue;
            const sessionId = normalizeDshId(nativeDir);
            if (wanted && sessionId !== wanted)
                continue;
            const isArchived = archived.has(sessionId);
            // A session DSH never attached to a workspace stays out of rule two.
            if (!isArchived && !grouped.has(sessionId))
                continue;
            foundWanted = true;
            const from = path.join(workspacePath, nativeDir);
            const stat = await fs.stat(from).catch(() => undefined);
            if (!stat?.isDirectory())
                continue;
            const activeMs = await lastActivityMs(from, stat.mtimeMs);
            const to = path.join(paths.archiveDir, workspaceDir, nativeDir);
            const item = {
                sessionId, storageId: storageDshId(sessionId), nativeDir, workspaceDir,
                from, to, mtimeMs: activeMs, sizeBytes: await dirSize(from),
                status: 'eligible',
                rule: isArchived ? 'archived' : 'active',
            };
            const group = groupOf(workspaceDir);
            const isPinned = pinned.has(sessionId);
            const tooRecent = !wanted && cutoffMs !== undefined && activeMs > cutoffMs;
            if (!isArchived && tooRecent) {
                // Still active and visible: it counts towards the pwd's floor.
                if (!isPinned)
                    group.remaining += 1;
                continue;
            }
            if (isPinned)
                Object.assign(item, { status: 'skipped', reason: 'pinned session' });
            else if (known.has(sessionId))
                Object.assign(item, { status: 'skipped', reason: 'already cold-archived' });
            else if (await isActiveLock(from, options.lockFreshMs ?? DEFAULT_LOCK_FRESH_MS))
                Object.assign(item, { status: 'skipped', reason: 'active session.lock' });
            else if (tooRecent)
                Object.assign(item, { status: 'skipped', reason: 'newer than retention window' });
            else if (await fs.lstat(to).then(() => true).catch(() => false))
                Object.assign(item, { status: 'conflict', reason: 'archive target already exists' });
            items.push(item);
            if (!isArchived) {
                // Rule two sweeps a session only when every check passes, and a pinned
                // session never takes a slot of the floor.
                if (item.status === 'eligible')
                    group.candidates.push(item);
                else if (!isPinned)
                    group.remaining += 1;
            }
        }
    }
    if (wanted && !foundWanted)
        throw new Error(`session directory not found: ${options.sessionId}`);
    // Every pwd keeps `keepActive` active conversations: when this pass would
    // leave it with fewer, the newest sessions it would sweep stay unarchived.
    if (!wanted && keepActive > 0) {
        for (const group of groups.values()) {
            group.candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
            let deficit = keepActive - group.remaining;
            for (let index = group.candidates.length - 1; index >= 0 && deficit > 0; index -= 1) {
                const item = group.candidates[index];
                item.status = 'skipped';
                item.reason = 'kept active for the pwd floor';
                deficit -= 1;
            }
        }
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
        dryRun: options.dryRun === true,
        ...(cutoffMs ? { cutoffMs } : {}),
        items,
        eligible: items.filter((item) => item.status === 'eligible'),
        skipped: items.filter((item) => item.status !== 'eligible'),
        bytes: items.filter((item) => item.status === 'eligible').reduce((sum, item) => sum + item.sizeBytes, 0),
    };
}
/** Read-only preview: creates no directories and changes no DSH state. */
export async function planArchive(options = {}) {
    return plan({ ...options, dryRun: true });
}
async function moveDir(from, to) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
        await fs.rename(from, to);
    }
    catch (error) {
        if (error.code !== 'EXDEV')
            throw error;
        // Cross-device archive roots: copy fully before removing the source.
        await fs.mkdir(to, { recursive: true });
        for (const entry of await fs.readdir(from, { withFileTypes: true })) {
            const src = path.join(from, entry.name);
            const dst = path.join(to, entry.name);
            if (entry.isDirectory())
                await moveDir(src, dst);
            else if (entry.isFile())
                await fs.copyFile(src, dst);
            else
                throw new Error(`cannot cold-archive special file: ${src}`);
        }
        await fs.rm(from, { recursive: true, force: true });
    }
}
/** Move eligible directories, then update the index and DSH's archived-id list atomically. */
export async function archiveSessions(options = {}) {
    const paths = options.paths ?? dshPaths();
    const planResult = await plan(options);
    if (planResult.dryRun || planResult.eligible.length === 0) {
        return { ...planResult, moved: [], freedBytes: 0, indexUpdated: false };
    }
    const state = await readWorkspaceState(paths);
    const index = await readColdIndex(paths);
    if (!state.raw)
        throw new Error(`DSH workspace storage not found: ${paths.workspaceFile}`);
    const moved = [];
    let workspaceWritten = false;
    let indexWritten = false;
    const indexRaw = await fs.readFile(coldIndexPath(paths), 'utf8').catch(() => undefined);
    try {
        for (const item of planResult.eligible) {
            // Re-check immediately before the move; a second writer must never be overwritten.
            if (await fs.lstat(item.to).then(() => true).catch(() => false)) {
                throw new Error(`archive target already exists: ${item.to}`);
            }
            await moveDir(item.from, item.to);
            moved.push({
                sessionId: item.sessionId, nativeDir: item.nativeDir, workspaceDir: item.workspaceDir,
                originalPath: item.from, archivePath: item.to,
                archivedAt: new Date().toISOString(), sizeBytes: item.sizeBytes,
            });
        }
        const ids = new Set(moved.flatMap((entry) => [entry.sessionId, storageDshId(entry.sessionId)]));
        const parsed = structuredClone(state.parsed);
        const global = (parsed.global ??= {});
        global.archivedSessionIds = state.archived.filter((id) => !ids.has(id));
        const backupPath = `${paths.workspaceFile}.cold-archive-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await writeAtomic(backupPath, state.raw);
        await writeAtomic(paths.workspaceFile, `${JSON.stringify(parsed, null, 2)}\n`);
        workspaceWritten = true;
        const nextIndex = { version: INDEX_VERSION, entries: [...index.entries, ...moved] };
        await writeAtomic(coldIndexPath(paths), `${JSON.stringify(nextIndex, null, 2)}\n`);
        indexWritten = true;
        return { ...planResult, moved, freedBytes: moved.reduce((sum, entry) => sum + entry.sizeBytes, 0), backupPath, indexUpdated: true };
    }
    catch (error) {
        if (workspaceWritten)
            await writeAtomic(paths.workspaceFile, state.raw);
        if (indexWritten)
            await writeAtomic(coldIndexPath(paths), indexRaw ?? `${JSON.stringify({ version: INDEX_VERSION, entries: [] }, null, 2)}\n`);
        for (const entry of moved.reverse()) {
            await moveDir(entry.archivePath, entry.originalPath).catch(() => { });
        }
        throw error;
    }
}
/** Migrate one session back to the hot tree and make it visible to DSH again. */
export async function restoreSession(options) {
    const paths = options.paths ?? dshPaths();
    const sessionId = normalizeDshId(options.sessionId);
    const index = await readColdIndex(paths);
    const entry = index.entries.find((item) => normalizeDshId(item.sessionId) === sessionId);
    if (!entry)
        throw new Error(`cold-archived session not found: ${options.sessionId}`);
    const to = path.join(paths.sessionsDir, entry.workspaceDir, entry.nativeDir);
    const result = { sessionId, from: entry.archivePath, to, dryRun: options.dryRun === true, restored: false };
    if (result.dryRun)
        return result;
    if (!(await fs.stat(entry.archivePath).then((stat) => stat.isDirectory()).catch(() => false))) {
        throw new Error(`cold archive directory is missing: ${entry.archivePath}`);
    }
    if (await fs.lstat(to).then(() => true).catch(() => false)) {
        throw new Error(`hot session target already exists, refusing to overwrite: ${to}`);
    }
    const state = await readWorkspaceState(paths);
    const indexRaw = await fs.readFile(coldIndexPath(paths), 'utf8').catch(() => `${JSON.stringify({ version: INDEX_VERSION, entries: [] }, null, 2)}\n`);
    let moved = false;
    let workspaceWritten = false;
    let indexWritten = false;
    try {
        await moveDir(entry.archivePath, to);
        moved = true;
        if (state.raw) {
            const parsed = structuredClone(state.parsed);
            const global = (parsed.global ??= {});
            global.archivedSessionIds = state.archived.filter((id) => normalizeDshId(id) !== sessionId);
            const backupPath = `${paths.workspaceFile}.restore-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            await writeAtomic(backupPath, state.raw);
            result.backupPath = backupPath;
            await writeAtomic(paths.workspaceFile, `${JSON.stringify(parsed, null, 2)}\n`);
            workspaceWritten = true;
        }
        const next = {
            version: INDEX_VERSION,
            entries: index.entries.filter((item) => normalizeDshId(item.sessionId) !== sessionId),
        };
        await writeAtomic(coldIndexPath(paths), `${JSON.stringify(next, null, 2)}\n`);
        indexWritten = true;
        result.restored = true;
        return result;
    }
    catch (error) {
        if (workspaceWritten)
            await writeAtomic(paths.workspaceFile, state.raw);
        if (indexWritten)
            await writeAtomic(coldIndexPath(paths), indexRaw);
        if (moved)
            await moveDir(to, entry.archivePath).catch(() => { });
        throw error;
    }
}
