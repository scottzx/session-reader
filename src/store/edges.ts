import type { DatabaseSync } from 'node:sqlite';
import { analyzableCommand } from '../writes.js';
import type { NormalizedSession, Provenance, TurnEvent } from '../types.js';
import { findSessionRow } from './read.js';
import { EDGE_VERSION } from './schema.js';

/**
 * How one session relates to another. Only the two we can prove today are
 * emitted; the rest are reserved so the vocabulary does not get invented
 * twice, and are never guessed from coincidence.
 */
export type EdgeRelation =
  | 'references'
  | 'handoff_from'
  | 'forked_from'
  | 'resumed_from'
  | 'sends_to';

/** Subcommands that address another session, and what reading one means. */
const VERB_RELATION: Record<string, EdgeRelation> = {
  overview: 'references',
  turns: 'references',
  turn: 'references',
  files: 'references',
  commands: 'references',
  errors: 'references',
  jobs: 'references',
  digest: 'references',
  graph: 'references',
  related: 'references',
  handoff: 'handoff_from',
};

/**
 * `1session <verb> <target>` in any of the shapes it actually gets typed:
 * the bare alias, `node …/1session.js`, `tsx bin/1session.ts`. Flags between
 * verb and target are skipped; the target must look like a session id.
 */
const INVOCATION =
  /(?:^|[\s;&|(])(?:[^\s;&|()]*\b1session(?:\.[jt]s)?)\s+([a-z-]+)((?:\s+--?[\w-]+(?:[= ][^\s;&|()]+)?)*)\s+([A-Za-z0-9][\w-]{5,})/g;

export interface EdgeCandidate {
  relation: EdgeRelation;
  target: string;
  eventIndex: number;
  operation: string;
  command: string;
  timestamp?: string;
}

/** Reads the session-reader invocations out of one tool call. */
export function invocationsOf(event: TurnEvent): EdgeCandidate[] {
  // Here-doc payloads are stripped first: this module's own development
  // sessions are full of `cat > x.ts <<'EOF'` blocks quoting example
  // commands, and counting those would invent edges that never happened.
  const command = analyzableCommand(event);
  if (!command) return [];
  const found: EdgeCandidate[] = [];
  INVOCATION.lastIndex = 0;
  for (const match of command.matchAll(INVOCATION)) {
    const verb = match[1]!;
    const relation = VERB_RELATION[verb];
    if (!relation) continue;
    found.push({
      relation,
      target: match[3]!,
      eventIndex: event.index,
      operation: verb,
      command: command.slice(match.index, match.index + 160).trim(),
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    });
  }
  return found;
}

function upsertEdge(
  db: DatabaseSync,
  from: string,
  to: string,
  relation: EdgeRelation,
  candidate: EdgeCandidate,
  provenance: Provenance,
  extractor: string,
): void {
  db.prepare(
    `INSERT INTO session_edges (from_session, to_session, relation, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (from_session, to_session, relation) DO UPDATE SET
       first_seen_at = MIN(COALESCE(first_seen_at, excluded.first_seen_at), COALESCE(excluded.first_seen_at, first_seen_at)),
       last_seen_at  = MAX(COALESCE(last_seen_at,  excluded.last_seen_at),  COALESCE(excluded.last_seen_at,  last_seen_at))`,
  ).run(from, to, relation, candidate.timestamp ?? null, candidate.timestamp ?? null);

  const edge = db
    .prepare(
      'SELECT id FROM session_edges WHERE from_session = ? AND to_session = ? AND relation = ?',
    )
    .get(from, to, relation) as { id: number };

  db.prepare(
    `INSERT OR IGNORE INTO edge_evidence
       (edge_id, source_session, event_index, operation, command, ts, provenance, extractor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    edge.id,
    from,
    candidate.eventIndex,
    candidate.operation,
    candidate.command,
    candidate.timestamp ?? null,
    provenance,
    extractor,
  );

  // Counted, never incremented: a re-index must not inflate the tally.
  db.prepare(
    'UPDATE session_edges SET evidence_count = (SELECT count(*) FROM edge_evidence WHERE edge_id = ?) WHERE id = ?',
  ).run(edge.id, edge.id);
}

/**
 * Derives L3 for one session from its stored events. Targets that do not
 * resolve to an indexed session are dropped — a dangling edge is worse than
 * no edge.
 */
export function deriveEdges(db: DatabaseSync, id: string, session: NormalizedSession): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    const stale = db
      .prepare('SELECT edge_id FROM edge_evidence WHERE source_session = ?')
      .all(id) as unknown as { edge_id: number }[];
    db.prepare('DELETE FROM edge_evidence WHERE source_session = ?').run(id);

    let added = 0;
    for (const event of session.turns) {
      for (const candidate of invocationsOf(event)) {
        const row = findSessionRow(db, candidate.target);
        if (!row || row.id === id) continue;
        upsertEdge(db, id, row.id, candidate.relation, candidate, 'derived', 'tool:Bash+1session');
        added++;
      }
    }

    // Edges whose last evidence just disappeared must go with it.
    for (const { edge_id } of stale) {
      db.prepare(
        'DELETE FROM session_edges WHERE id = ? AND NOT EXISTS (SELECT 1 FROM edge_evidence WHERE edge_id = ?)',
      ).run(edge_id, edge_id);
    }
    db.prepare('UPDATE sessions SET edge_version = ? WHERE id = ?').run(EDGE_VERSION, id);
    db.exec('COMMIT');
    return added;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Records an edge at the moment it happens, when the caller session is known.
 * Injected by a hook or the ACP context as `SESSION_READER_CALLER_SESSION`;
 * absent everywhere else, in which case nothing is written.
 */
export function captureRuntimeEdge(
  db: DatabaseSync,
  verb: string,
  target: string,
): void {
  const caller = process.env.SESSION_READER_CALLER_SESSION?.trim();
  const relation = VERB_RELATION[verb];
  if (!caller || !relation) return;
  const from = findSessionRow(db, caller);
  const to = findSessionRow(db, target);
  if (!from || !to || from.id === to.id) return;
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    upsertEdge(
      db,
      from.id,
      to.id,
      relation,
      { relation, target, eventIndex: -1, operation: verb, command: `1session ${verb} ${target}`, timestamp: now },
      'observed',
      'runtime:caller-env',
    );
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
  }
}

export interface EdgeView {
  from: string;
  to: string;
  relation: EdgeRelation;
  evidenceCount: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  direction: 'out' | 'in';
}

export function edgesOf(db: DatabaseSync, id: string): EdgeView[] {
  const rows = db
    .prepare(
      `SELECT from_session, to_session, relation, evidence_count, first_seen_at, last_seen_at
       FROM session_edges WHERE from_session = ? OR to_session = ?
       ORDER BY evidence_count DESC`,
    )
    .all(id, id) as unknown as {
    from_session: string;
    to_session: string;
    relation: string;
    evidence_count: number;
    first_seen_at: string | null;
    last_seen_at: string | null;
  }[];
  return rows.map((row) => ({
    from: row.from_session,
    to: row.to_session,
    relation: row.relation as EdgeRelation,
    evidenceCount: row.evidence_count,
    ...(row.first_seen_at ? { firstSeenAt: row.first_seen_at } : {}),
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
    direction: row.from_session === id ? ('out' as const) : ('in' as const),
  }));
}

export function edgeEvidence(
  db: DatabaseSync,
  from: string,
  to: string,
  relation: string,
): { eventIndex: number; operation: string; ts?: string; extractor: string }[] {
  const rows = db
    .prepare(
      `SELECT e.event_index, e.operation, e.ts, e.extractor
       FROM edge_evidence e JOIN session_edges s ON s.id = e.edge_id
       WHERE s.from_session = ? AND s.to_session = ? AND s.relation = ?
       ORDER BY e.event_index`,
    )
    .all(from, to, relation) as unknown as {
    event_index: number;
    operation: string;
    ts: string | null;
    extractor: string;
  }[];
  return rows.map((row) => ({
    eventIndex: row.event_index,
    operation: row.operation,
    ...(row.ts ? { ts: row.ts } : {}),
    extractor: row.extractor,
  }));
}
