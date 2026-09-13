/**
 * Index store schema and the version constants that decide what is stale.
 *
 * The four versions are independent on purpose: a change to fact extraction
 * must not force a re-read of 600MB of JSONL, it only invalidates the layer it
 * actually touched. Bump the matching constant in the same commit that changes
 * the behaviour — never derive them from a git hash, `dist` ships without git.
 */

/** DDL layout. A bump drops and rebuilds the whole database. */
export const SCHEMA_VERSION = 1;
/** L1 semantics — anything in `parsers/` that changes normalized events. */
export const PARSER_VERSION = 1;
/** L2 rules — `writes.ts` / `ledger.ts`. Re-derives facts from stored events. */
export const EXTRACTOR_VERSION = 1;
/** L3 rules — `store/edges.ts`. Re-derives edges from stored events. */
export const EDGE_VERSION = 1;

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,          -- canonical "provider:native_id"
  provider          TEXT NOT NULL,
  native_id         TEXT NOT NULL,
  source_path       TEXT NOT NULL,
  workspace         TEXT,
  title             TEXT,
  started_at        TEXT,
  ended_at          TEXT,
  event_count       INTEGER NOT NULL DEFAULT 0,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  source_size       INTEGER NOT NULL DEFAULT 0,
  source_mtime_ms   INTEGER NOT NULL DEFAULT 0,
  head_hash         TEXT,
  aux_fingerprint   TEXT,
  indexed_bytes     INTEGER NOT NULL DEFAULT 0, -- reserved for resumable parse
  parser_version    INTEGER NOT NULL DEFAULT 0,
  extractor_version INTEGER NOT NULL DEFAULT 0,
  edge_version      INTEGER NOT NULL DEFAULT 0,
  indexed_at        TEXT,
  artifacts_json    TEXT,
  stats_json        TEXT
);

CREATE TABLE IF NOT EXISTS events (
  session_id     TEXT NOT NULL,
  idx            INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  text           TEXT,
  tool_name      TEXT,
  tool_args_json TEXT,
  tool_result    TEXT,
  is_error       INTEGER,
  ts             TEXT,
  source_index   INTEGER,
  exit_code      INTEGER,
  pid            TEXT,
  duration_ms    INTEGER,
  provider_truncated INTEGER,                 -- the provider's own "shortened copy" flag
  PRIMARY KEY (session_id, idx)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS file_ops (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  host        TEXT,
  operation   TEXT NOT NULL,
  turn        INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  ts          TEXT,
  provenance  TEXT NOT NULL,
  extractor   TEXT NOT NULL,
  file_group  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  session_id  TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  turn        INTEGER NOT NULL,
  command     TEXT NOT NULL,
  host        TEXT,
  cwd         TEXT,
  exit_code   INTEGER,
  duration_ms INTEGER,
  pid         TEXT,
  stderr      TEXT,
  ts          TEXT,
  provenance  TEXT NOT NULL,
  extractor   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  session_id     TEXT NOT NULL,
  job_id         TEXT NOT NULL,
  command        TEXT,
  pid            TEXT,
  host           TEXT,
  log            TEXT,
  started_at     TEXT,
  discovered_from INTEGER,
  status         TEXT NOT NULL,
  provenance     TEXT NOT NULL,
  extractor      TEXT NOT NULL,
  evidence_json  TEXT
);

CREATE TABLE IF NOT EXISTS session_edges (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session   TEXT NOT NULL,
  to_session     TEXT NOT NULL,
  relation       TEXT NOT NULL,
  first_seen_at  TEXT,
  last_seen_at   TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (from_session, to_session, relation)
);

CREATE TABLE IF NOT EXISTS edge_evidence (
  edge_id       INTEGER NOT NULL,
  source_session TEXT NOT NULL,
  event_index   INTEGER NOT NULL,
  operation     TEXT NOT NULL,
  command       TEXT,
  ts            TEXT,
  provenance    TEXT NOT NULL,
  extractor     TEXT NOT NULL,
  UNIQUE (edge_id, source_session, event_index)
);

CREATE INDEX IF NOT EXISTS idx_events_kind      ON events (session_id, kind);
CREATE INDEX IF NOT EXISTS idx_fileops_path     ON file_ops (path);
CREATE INDEX IF NOT EXISTS idx_fileops_session  ON file_ops (session_id);
CREATE INDEX IF NOT EXISTS idx_commands_session ON commands (session_id, exit_code);
CREATE INDEX IF NOT EXISTS idx_jobs_session     ON jobs (session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_ws      ON sessions (workspace, ended_at);
CREATE INDEX IF NOT EXISTS idx_sessions_native  ON sessions (native_id);
CREATE INDEX IF NOT EXISTS idx_edges_to         ON session_edges (to_session);
`;

/** Tables holding derived rows — dropped wholesale when a layer is rebuilt. */
export const L2_TABLES = ['file_ops', 'commands', 'jobs'] as const;
