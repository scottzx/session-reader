import type { DatabaseSync } from 'node:sqlite';
import { commandLedger, fileLedger, jobLedger } from '../ledger.js';
import type { NormalizedSession } from '../types.js';
import { EXTRACTOR_VERSION } from './schema.js';

/**
 * Materializes L2. The rules themselves stay in `ledger.ts` — this only moves
 * their output into rows, so a stored fact and a freshly computed one can
 * never disagree.
 */
export function deriveFacts(db: DatabaseSync, id: string, session: NormalizedSession): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['file_ops', 'commands', 'jobs']) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
    }

    const file = db.prepare(
      `INSERT INTO file_ops (session_id, path, host, operation, turn, event_index, ts,
                             provenance, extractor, file_group)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const record of fileLedger(session)) {
      file.run(
        id,
        record.path,
        record.host ?? null,
        record.operation,
        record.turn,
        record.eventIndex,
        record.timestamp ?? null,
        record.provenance,
        record.extractor,
        record.group,
      );
    }

    const command = db.prepare(
      `INSERT INTO commands (session_id, event_index, turn, command, host, cwd, exit_code,
                             duration_ms, pid, stderr, ts, provenance, extractor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const record of commandLedger(session)) {
      command.run(
        id,
        record.eventIndex,
        record.turn,
        record.command,
        record.host ?? null,
        record.cwd ?? null,
        record.exitCode ?? null,
        record.durationMs ?? null,
        record.pid ?? null,
        record.stderr ?? null,
        record.timestamp ?? null,
        record.provenance,
        record.extractor,
      );
    }

    const job = db.prepare(
      `INSERT INTO jobs (session_id, job_id, command, pid, host, log, started_at,
                         discovered_from, status, provenance, extractor, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const record of jobLedger(session)) {
      job.run(
        id,
        record.id,
        record.command ?? null,
        record.pid ?? null,
        record.host ?? null,
        record.log ?? null,
        record.startedAt ?? null,
        record.discoveredFrom ?? null,
        record.status,
        record.provenance,
        record.extractor,
        JSON.stringify(record.evidence),
      );
    }

    db.prepare('UPDATE sessions SET extractor_version = ? WHERE id = ?').run(
      EXTRACTOR_VERSION,
      id,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
