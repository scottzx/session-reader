import type { DatabaseSync } from 'node:sqlite';
import type { ProviderAdapter, SessionCandidate } from '../parsers/provider.js';
import { summarizeTurns } from '../turns.js';
import type { NormalizedSession } from '../types.js';
import { deriveEdges } from './edges.js';
import { deriveFacts } from './facts.js';
import { readSession, sessionRow } from './read.js';
import { EDGE_VERSION, EXTRACTOR_VERSION, PARSER_VERSION } from './schema.js';
import { canonicalId, fingerprintOf, writeSession } from './write.js';

export type IndexAction = 'indexed' | 'reused' | 'facts-rederived' | 'edges-rederived';

export interface IndexResult {
  id: string;
  action: IndexAction;
  session: NormalizedSession;
}

export interface IndexHandle {
  adapter: ProviderAdapter;
  candidate: SessionCandidate;
}

export interface IndexOptions {
  /** Re-read the source even when the fingerprint says nothing changed. */
  force?: boolean;
  /** Skip L3 — a bulk backfill derives edges once at the end instead. */
  edges?: boolean;
}

/**
 * Brings one session's index up to date and returns it.
 *
 * The three layers are invalidated independently: only a changed fingerprint
 * or a new `PARSER_VERSION` costs a file read. A new `EXTRACTOR_VERSION` or
 * `EDGE_VERSION` re-derives from the stored events alone.
 */
export async function indexSession(
  db: DatabaseSync,
  handle: IndexHandle,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const { adapter, candidate } = handle;
  const id = canonicalId(adapter.provider, candidate.id);
  const aux = await adapter.auxFingerprint?.(candidate);
  const fingerprint = fingerprintOf(candidate, aux);
  const row = sessionRow(db, id);

  const l1Valid =
    !!row &&
    !options.force &&
    row.parser_version === PARSER_VERSION &&
    row.source_size === fingerprint.sourceSize &&
    row.source_mtime_ms === fingerprint.sourceMtimeMs &&
    row.head_hash === fingerprint.headHash &&
    (row.aux_fingerprint ?? undefined) === fingerprint.auxFingerprint;

  if (!l1Valid) {
    const session = await adapter.parse(candidate);
    writeSession(db, session, fingerprint, summarizeTurns(session).length);
    deriveFacts(db, id, session);
    if (options.edges !== false) deriveEdges(db, id, session);
    return { id, action: 'indexed', session };
  }

  const session = readSession(db, row);
  let action: IndexAction = 'reused';
  if (row.extractor_version !== EXTRACTOR_VERSION) {
    deriveFacts(db, id, session);
    action = 'facts-rederived';
  }
  if (options.edges !== false && row.edge_version !== EDGE_VERSION) {
    deriveEdges(db, id, session);
    action = action === 'reused' ? 'edges-rederived' : action;
  }
  return { id, action, session };
}
