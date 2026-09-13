import fs from 'node:fs';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentProvider, NormalizedSession } from '../types.js';
import type { SessionCandidate } from '../parsers/provider.js';
import { PARSER_VERSION } from './schema.js';

/** Store key. `SessionRef.id` stays the provider-native id, untouched. */
export function canonicalId(provider: AgentProvider, nativeId: string): string {
  return `${provider}:${nativeId}`;
}

/** Bytes of the file head that go into the fingerprint. */
const HEAD_BYTES = 64 * 1024;

export interface Fingerprint {
  sourceSize: number;
  sourceMtimeMs: number;
  headHash: string;
  auxFingerprint?: string;
}

/**
 * Identity of the bytes we parsed. JSONL is append-only in practice, so a
 * matching head hash rules out the one case size+mtime cannot: a rewrite that
 * happens to land on the same length.
 */
export function fingerprintOf(candidate: SessionCandidate, aux?: string): Fingerprint {
  let headHash = '';
  try {
    const fd = fs.openSync(candidate.path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, candidate.sizeBytes || HEAD_BYTES));
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      headHash = crypto.createHash('sha256').update(buffer.subarray(0, read)).digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* unreadable head — size+mtime still gate re-indexing */
  }
  return {
    sourceSize: candidate.sizeBytes,
    sourceMtimeMs: Math.round(candidate.mtimeMs),
    headHash,
    ...(aux ? { auxFingerprint: aux } : {}),
  };
}

/**
 * Replaces the L1 rows of one session. Everything derived from it (L2, L3) is
 * dropped in the same transaction, so the database is never half-new.
 */
export function writeSession(
  db: DatabaseSync,
  session: NormalizedSession,
  fingerprint: Fingerprint,
  turnCount: number,
): string {
  const id = canonicalId(session.ref.provider, session.ref.id);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['events', 'file_ops', 'commands', 'jobs']) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    db.prepare(
      `INSERT INTO sessions (
         id, provider, native_id, source_path, workspace, title, started_at, ended_at,
         event_count, turn_count, source_size, source_mtime_ms, head_hash, aux_fingerprint,
         parser_version, extractor_version, edge_version, indexed_at, artifacts_json, stats_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    ).run(
      id,
      session.ref.provider,
      session.ref.id,
      session.ref.path,
      session.ref.workspace ?? null,
      session.ref.title ?? null,
      session.ref.createdAt ?? null,
      session.ref.updatedAt ?? null,
      session.turns.length,
      turnCount,
      fingerprint.sourceSize,
      fingerprint.sourceMtimeMs,
      fingerprint.headHash,
      fingerprint.auxFingerprint ?? null,
      PARSER_VERSION,
      new Date().toISOString(),
      JSON.stringify(session.artifacts),
      JSON.stringify(session.stats),
    );

    const insert = db.prepare(
      `INSERT INTO events (
         session_id, idx, kind, text, tool_name, tool_args_json, tool_result, is_error,
         ts, source_index, exit_code, pid, duration_ms, provider_truncated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Event text is stored whole. Capping it at 128KB shrank the index by
    // 0.08% and silently dropped search hits from long build logs — exactly
    // the kind of "looks complete, isn't" answer this store exists to remove.
    for (const event of session.turns) {
      insert.run(
        id,
        event.index,
        event.kind,
        event.text ?? null,
        event.toolName ?? null,
        event.toolArgs ? JSON.stringify(event.toolArgs) : null,
        event.toolResult ?? null,
        event.isError === undefined ? null : event.isError ? 1 : 0,
        event.timestamp ?? null,
        event.sourceIndex ?? null,
        event.exitCode ?? null,
        event.processId ?? null,
        event.durationMs ?? null,
        event.truncated === undefined ? null : event.truncated ? 1 : 0,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return id;
}
