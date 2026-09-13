import fs from 'node:fs/promises';
import path from 'node:path';
import { antigravityAdapter } from './parsers/antigravity.js';
import { claudeAdapter } from './parsers/claude.js';
import { codexAdapter } from './parsers/codex.js';
import type { ProviderAdapter, SessionCandidate } from './parsers/provider.js';
import { canonicalizePath, isInside, slugifyWorkspace } from './util/paths.js';
import type { AgentProvider, NormalizedSession, SessionRef } from './types.js';

export const adapters: ProviderAdapter[] = [antigravityAdapter, claudeAdapter, codexAdapter];

/** How many files we are willing to open when nothing narrows the search. */
const DEFAULT_SCAN = 60;
/** A workspace filter rejects most candidates, so it needs a wider net. */
const WORKSPACE_SCAN = 600;

export interface ListOptions {
  limit?: number;
  /**
   * Serve the listing from the index (the default). The sweep still checks
   * every session file's fingerprint, but only the ones whose bytes moved are
   * parsed again — so a listing is complete regardless of `scan`, and cheap
   * after the first run. Set false to read the source files directly.
   */
  useIndex?: boolean;
  /**
   * How many session files may be opened. Defaults to a small budget so an
   * unfiltered `list` stays cheap; pass `Infinity` when completeness matters
   * more than latency (indexing, search).
   */
  scan?: number;
  workspace?: string;
  provider?: AgentProvider;
  /** Only sessions updated at or after this moment (`24h`, `7d`, ISO date). */
  since?: string | Date;
}

export interface ResolvedSession {
  ref: SessionRef;
  adapter: ProviderAdapter;
  candidate: SessionCandidate;
}

/** Accepts `24h`, `90m`, `7d`, `2026-09-01` or a Date. */
export function parseSince(since: string | Date | undefined): number | undefined {
  if (!since) return undefined;
  if (since instanceof Date) return since.getTime();
  const relative = /^(\d+)\s*([hdmw])$/i.exec(since.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit] ?? 0;
    return Date.now() - amount * ms;
  }
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function matchesWorkspace(ref: SessionRef, workspace: string): boolean {
  if (!ref.workspace) return false;
  return isInside(workspace, ref.workspace);
}

/**
 * Claude stores sessions under a slugified cwd, so the directory name alone
 * tells us whether a file can possibly belong to the workspace.
 */
function couldBelong(candidate: SessionCandidate, provider: AgentProvider, workspace: string): boolean {
  if (provider !== 'claude') return true;
  const slug = slugifyWorkspace(workspace);
  const dir = path.basename(path.dirname(candidate.path));
  return dir === slug || dir.startsWith(`${slug}-`);
}

/** Discovery that keeps the adapter handle, so callers can parse without a second scan. */
export async function listResolvedSessions(options: ListOptions = {}): Promise<ResolvedSession[]> {
  const limit = options.limit ?? 20;
  // `/` contains every session by definition, so filtering on it would only
  // cost a scan and drop the sessions whose cwd we could not recover.
  const scoped = options.workspace ? canonicalizePath(options.workspace) : undefined;
  const workspace = scoped && scoped !== '/' ? scoped : undefined;
  const sinceMs = parseSince(options.since);
  const found: ResolvedSession[] = [];

  for (const adapter of adapters) {
    if (options.provider && adapter.provider !== options.provider) continue;
    const candidates = await adapter.listCandidates();
    let scanned = 0;
    const budget = options.scan ?? (workspace ? WORKSPACE_SCAN : DEFAULT_SCAN);
    for (const candidate of candidates) {
      if (sinceMs && candidate.mtimeMs < sinceMs) break; // candidates are newest first
      if (scanned >= budget) break;
      if (workspace && !couldBelong(candidate, adapter.provider, workspace)) continue;
      scanned++;
      const ref = await adapter.scanRef(candidate).catch(() => undefined);
      if (!ref) continue;
      if (workspace && !matchesWorkspace(ref, workspace)) continue;
      found.push({ ref, adapter, candidate });
    }
  }

  return found
    .sort((a, b) => Date.parse(b.ref.updatedAt ?? '') - Date.parse(a.ref.updatedAt ?? ''))
    .slice(0, limit);
}

export async function listRecentSessions(options: ListOptions = {}): Promise<SessionRef[]> {
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
async function listIndexedSessions(options: ListOptions): Promise<SessionRef[]> {
  const { openStore } = await import('./store/db.js');
  const { refreshSession } = await import('./store/indexer.js');
  const { listSessionRows, refOf } = await import('./store/read.js');
  const db = await openStore();
  const sinceMs = parseSince(options.since);
  const ids: string[] = [];

  for (const adapter of adapters) {
    if (options.provider && adapter.provider !== options.provider) continue;
    for (const candidate of await adapter.listCandidates()) {
      if (sinceMs && candidate.mtimeMs < sinceMs) break; // candidates are newest first
      const result = await refreshSession(db, { adapter, candidate }, { edges: false }).catch(
        () => undefined,
      );
      if (result) ids.push(result.id);
    }
  }

  const scoped = options.workspace ? canonicalizePath(options.workspace) : undefined;
  return listSessionRows(db, {
    ids,
    ...(scoped && scoped !== '/' ? { workspace: scoped } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(sinceMs ? { sinceMs } : {}),
    limit: options.limit ?? 20,
  }).map(refOf);
}

export async function findSessionsByWorkspace(
  workspacePath: string,
  options: Omit<ListOptions, 'workspace'> = {},
): Promise<SessionRef[]> {
  return listRecentSessions({ ...options, limit: options.limit ?? 50, workspace: workspacePath });
}

export async function findResolvedByWorkspace(
  workspacePath: string,
  options: Omit<ListOptions, 'workspace'> = {},
): Promise<ResolvedSession[]> {
  return listResolvedSessions({ ...options, limit: options.limit ?? 50, workspace: workspacePath });
}

/** Locates a session by full id, id prefix, or native file path. */
export async function resolveSession(sessionId: string): Promise<ResolvedSession | undefined> {
  const asPath = sessionId.includes('/') ? canonicalizePath(sessionId) : undefined;
  const needle = sessionId.toLowerCase();
  let prefixHit: { adapter: ProviderAdapter; candidate: SessionCandidate } | undefined;

  for (const adapter of adapters) {
    for (const candidate of await adapter.listCandidates()) {
      if (asPath ? candidate.path === asPath : candidate.id.toLowerCase() === needle) {
        return { ref: await adapter.scanRef(candidate), adapter, candidate };
      }
      if (!asPath && !prefixHit && needle.length >= 6 && candidate.id.toLowerCase().startsWith(needle)) {
        prefixHit = { adapter, candidate };
      }
    }
  }
  if (!prefixHit) return undefined;
  return { ...prefixHit, ref: await prefixHit.adapter.scanRef(prefixHit.candidate) };
}

export async function parseSession(sessionId: string): Promise<NormalizedSession> {
  const resolved = await resolveSession(sessionId);
  if (!resolved) throw new Error(`session not found: ${sessionId}`);
  return resolved.adapter.parse(resolved.candidate);
}

export interface LoadOptions {
  /** Set false to bypass the index entirely (CI, read-only checkouts). */
  useIndex?: boolean;
  force?: boolean;
}

/**
 * The one seam every command loads sessions through. Whether the events come
 * from the index or straight off disk, the object handed back is the same, so
 * `buildOverview` / `fileLedger` / `summarizeTurns` never learn about caching.
 */
export async function loadSession(
  sessionId: string,
  options: LoadOptions = {},
): Promise<NormalizedSession> {
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
  const handle = (row ? await handleFromPath(row.provider, row.native_id, row.source_path) : undefined)
    ?? (await resolveSession(sessionId));
  if (!handle) throw new Error(`session not found: ${sessionId}`);
  const result = await indexSession(db, handle, { ...(options.force ? { force: true } : {}) });
  return result.session;
}

/** Rebuilds an adapter handle from an indexed row without a directory scan. */
async function handleFromPath(
  provider: string,
  nativeId: string,
  sourcePath: string,
): Promise<{ adapter: ProviderAdapter; candidate: SessionCandidate } | undefined> {
  const adapter = adapters.find((item) => item.provider === provider);
  if (!adapter) return undefined;
  const stat = await fs.stat(sourcePath).catch(() => undefined);
  if (!stat) return undefined;
  return {
    adapter,
    candidate: { id: nativeId, path: sourcePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size },
  };
}
