import { decodeText } from './nul.js';
import type { DatabaseSync } from 'node:sqlite';
import { turnStartsFrom } from '../turns.js';
import {
  emptyProviderStats,
  type AgentProvider,
  type NormalizedSession,
  type ProviderStats,
  type SessionArtifact,
  type SessionRef,
  type TurnEvent,
  type TurnKind,
} from '../types.js';

export interface SessionRow {
  id: string;
  provider: string;
  native_id: string;
  source_path: string;
  workspace: string | null;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  event_count: number;
  turn_count: number;
  source_size: number;
  source_mtime_ms: number;
  head_hash: string | null;
  aux_fingerprint: string | null;
  parser_version: number;
  extractor_version: number;
  edge_version: number;
  indexed_at: string | null;
  artifacts_json: string | null;
  stats_json: string | null;
}

export function sessionRow(db: DatabaseSync, id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

/** Resolves a full id, an id prefix, or a native id against the index. */
export function findSessionRow(db: DatabaseSync, needle: string): SessionRow | undefined {
  const exact = db
    .prepare('SELECT * FROM sessions WHERE id = ? OR native_id = ? LIMIT 1')
    .get(needle, needle) as SessionRow | undefined;
  if (exact) return exact;
  if (needle.length < 6) return undefined;
  return db
    .prepare('SELECT * FROM sessions WHERE native_id LIKE ? ORDER BY ended_at DESC LIMIT 1')
    .get(`${needle}%`) as SessionRow | undefined;
}

export interface ListQuery {
  /**
   * Ids seen on disk during this sweep; rows outside it are stale and skipped.
   * Omit to list from the whole index (lazy UI listings that skip the sweep).
   * An explicit empty array still means "nothing in scope".
   */
  ids?: string[];
  /** Canonical root; matches the directory itself and everything under it. */
  workspace?: string;
  provider?: string;
  sinceMs?: number;
  limit?: number;
}

/**
 * The listing served from the index: newest first, no scan budget, so a
 * workspace never silently loses its older sessions to a candidate cap.
 */
export function listSessionRows(db: DatabaseSync, query: ListQuery): SessionRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (query.ids) {
    if (!query.ids.length) return [];
    db.exec('DROP TABLE IF EXISTS temp.list_scope');
    db.exec('CREATE TEMP TABLE list_scope (id TEXT PRIMARY KEY)');
    const insert = db.prepare('INSERT OR IGNORE INTO temp.list_scope (id) VALUES (?)');
    for (const id of query.ids) insert.run(id);
    where.push('id IN (SELECT id FROM temp.list_scope)');
  }

  if (query.workspace) {
    // Prefix comparison rather than LIKE: real paths contain `_`, a LIKE wildcard.
    where.push('(workspace = ? OR substr(workspace, 1, ?) = ?)');
    params.push(query.workspace, query.workspace.length + 1, `${query.workspace}/`);
  }
  if (query.provider) {
    where.push('provider = ?');
    params.push(query.provider);
  }
  if (query.sinceMs) {
    where.push('source_mtime_ms >= ?');
    params.push(query.sinceMs);
  }
  params.push(query.limit ?? 20);
  const sql =
    `SELECT * FROM sessions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
    // Undated rows sort last instead of first, which is where DESC puts NULL.
    'ORDER BY (ended_at IS NULL), ended_at DESC LIMIT ?';
  return db.prepare(sql).all(...params) as unknown as SessionRow[];
}

/**
 * Turn starts for one indexed session, without rebuilding it.
 *
 * The rule has to stay the rule `turnStarts` applies to a parsed session — a
 * user event carrying real text opens a turn — so the two are fed to the same
 * `turnStartsFrom`; only the source of the indices differs.
 */
export function turnStartsOf(db: DatabaseSync, sessionId: string, eventCount: number): number[] {
  const rows = db
    .prepare(
      `SELECT idx FROM events
        WHERE session_id = ? AND kind = 'user' AND trim(coalesce(text, '')) != ''
        ORDER BY idx`,
    )
    .all(sessionId) as unknown as { idx: number }[];
  return turnStartsFrom(
    rows.map((row) => row.idx),
    eventCount,
  );
}

export function refOf(row: SessionRow): SessionRef {
  return {
    id: row.native_id,
    provider: row.provider as AgentProvider,
    path: row.source_path,
    ...(row.title === null ? {} : { title: decodeText(row.title) }),
    ...(row.workspace === null ? {} : { workspace: row.workspace }),
    ...(row.started_at === null ? {} : { createdAt: row.started_at }),
    ...(row.ended_at === null ? {} : { updatedAt: row.ended_at }),
    sizeBytes: row.source_size,
  };
}

interface EventRow {
  idx: number;
  kind: string;
  text: string | null;
  tool_name: string | null;
  tool_args_json: string | null;
  tool_result: string | null;
  is_error: number | null;
  ts: string | null;
  source_index: number | null;
  exit_code: number | null;
  pid: string | null;
  duration_ms: number | null;
  provider_truncated: number | null;
}

/**
 * Rebuilds events exactly as the parser emitted them — absent optionals stay
 * absent, so the result deep-equals a fresh `parse()`.
 */
function eventsOf(db: DatabaseSync, id: string, nativeId: string): TurnEvent[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY idx')
    .all(id) as unknown as EventRow[];
  return rows.map((row) => ({
    id: `${nativeId}#${row.idx}`,
    index: row.idx,
    kind: row.kind as TurnKind,
    ...(row.text === null ? {} : { text: decodeText(row.text) }),
    ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    ...(row.tool_args_json === null
      ? {}
      : { toolArgs: JSON.parse(row.tool_args_json) as Record<string, unknown> }),
    ...(row.tool_result === null ? {} : { toolResult: decodeText(row.tool_result) }),
    ...(row.is_error === null ? {} : { isError: row.is_error === 1 }),
    ...(row.ts === null ? {} : { timestamp: row.ts }),
    ...(row.source_index === null ? {} : { sourceIndex: row.source_index }),
    ...(row.provider_truncated === null ? {} : { truncated: row.provider_truncated === 1 }),
    ...(row.pid === null ? {} : { processId: row.pid }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
  }));
}

export function readSession(db: DatabaseSync, row: SessionRow): NormalizedSession {
  const artifacts = row.artifacts_json
    ? (JSON.parse(row.artifacts_json) as SessionArtifact[])
    : [];
  const stats = row.stats_json
    ? (JSON.parse(row.stats_json) as ProviderStats)
    : emptyProviderStats();
  return {
    ref: refOf(row),
    turns: eventsOf(db, row.id, row.native_id),
    artifacts,
    stats,
  };
}
