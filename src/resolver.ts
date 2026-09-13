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
  const workspace = options.workspace ? canonicalizePath(options.workspace) : undefined;
  const sinceMs = parseSince(options.since);
  const found: ResolvedSession[] = [];

  for (const adapter of adapters) {
    if (options.provider && adapter.provider !== options.provider) continue;
    const candidates = await adapter.listCandidates();
    let scanned = 0;
    const budget = workspace ? WORKSPACE_SCAN : DEFAULT_SCAN;
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
  return (await listResolvedSessions(options)).map((session) => session.ref);
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
