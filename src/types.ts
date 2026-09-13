/** Canonical domain types shared by every provider parser. */

export type AgentProvider = 'antigravity' | 'claude' | 'codex' | 'cursor' | 'unknown';

/** Cheap metadata about a discovered session, obtained without a full parse. */
export interface SessionRef {
  id: string;
  provider: AgentProvider;
  /** Native file that holds the transcript. */
  path: string;
  title?: string;
  /** Canonical absolute working directory the session ran in. */
  workspace?: string;
  createdAt?: string;
  updatedAt?: string;
  sizeBytes?: number;
}

export type TurnKind = 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result';

export interface TurnEvent {
  id: string;
  index: number;
  kind: TurnKind;
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  timestamp?: string;
  /** Provider-native index of the record this event came from. */
  sourceIndex?: number;
  /** The provider stored a shortened copy; the full text lives elsewhere. */
  truncated?: boolean;
  /** OS process id, when the provider records one for a command. */
  processId?: string;
  /** Shell exit status, when the provider records or prints one. */
  exitCode?: number;
  durationMs?: number;
}

/** A file the agent produced alongside the session (plans, reports, images). */
export interface SessionArtifact {
  name: string;
  path: string;
  kind: 'markdown' | 'image' | 'other';
  /** Only read for text artifacts. */
  content?: string;
  /** The agent's own one-line description, when it recorded one. */
  summary?: string;
  sizeBytes?: number;
  updatedAt?: string;
}

/**
 * How much a fact is worth trusting.
 * - `observed`  — the provider recorded it as a structured field of its own.
 * - `derived`   — a deterministic rule over an action that provably ran.
 * - `candidate` — merely mentioned in text; nobody was seen acting on it.
 */
export type Provenance = 'observed' | 'derived' | 'candidate';

/** Answers "why do you believe this?" for a single extracted fact. */
export interface FactSource {
  provenance: Provenance;
  /** The rule that produced it, e.g. `tool:Write`, `shell:redirect`. */
  extractor: string;
  /** Event index it was extracted from. */
  event?: number;
  turn?: number;
}

export interface FileChange {
  path: string;
  change: 'add' | 'update' | 'delete';
  sizeBytes?: number;
}

export interface BackgroundTask {
  id: string;
  title?: string;
  log?: string;
  /** Only trustworthy when the provider records completion notices. */
  finished: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  /** Prefix replays served from cache — reported separately, never as input. */
  cacheRead?: number;
}

export interface TurnBoundary {
  /** Provider turn id — boundaries must be paired by id, never by position. */
  id?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  lastMessage?: string;
  /** A start with no matching completion means the turn never wrapped up. */
  completed: boolean;
}

/** One shell command with whatever the provider actually recorded about it. */
export interface CommandRecord {
  eventIndex: number;
  turn: number;
  command: string;
  host?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  pid?: string;
  stderr?: string;
  timestamp?: string;
  provenance: Provenance;
  extractor: string;
  /** Errors only: a later command with the same prefix exited zero. */
  laterSucceeded?: boolean;
}

export type JobStatus = 'completed' | 'failed' | 'running' | 'unknown';

export interface AsyncJob {
  id: string;
  command?: string;
  pid?: string;
  host?: string;
  log?: string;
  startedAt?: string;
  discoveredFrom?: number;
  provenance: Provenance;
  extractor: string;
  status: JobStatus;
  /** Why we claim that status. Never empty for anything but `unknown`. */
  evidence: string[];
}

export type FileGroup = 'project' | 'runtime' | 'log';

export interface FileRecord {
  path: string;
  host?: string;
  operation: string;
  turn: number;
  eventIndex: number;
  timestamp?: string;
  provenance: Provenance;
  extractor: string;
  group: FileGroup;
}

/** Structured facts a provider records natively — never inferred by us. */
export interface ProviderStats {
  tokens?: TokenUsage;
  models: string[];
  branches: string[];
  /** Authoritative file changes, when the provider tracks them itself. */
  fileChanges: FileChange[];
  commandExecutions?: number;
  uploads: { name: string; path: string; sizeBytes?: number }[];
  backgroundTasks: BackgroundTask[];
  /** Provider-declared turn boundaries (codex task_started/task_complete). */
  turnBoundaries: TurnBoundary[];
  /** Command ledger, when the provider records commands itself. */
  commands: CommandRecord[];
  /** Counts of anything else worth surfacing: images viewed, compactions… */
  extras: Record<string, number>;
}

export function emptyProviderStats(): ProviderStats {
  return {
    models: [],
    branches: [],
    fileChanges: [],
    uploads: [],
    backgroundTasks: [],
    turnBoundaries: [],
    commands: [],
    extras: {},
  };
}

export interface NormalizedSession {
  ref: SessionRef;
  turns: TurnEvent[];
  artifacts: SessionArtifact[];
  stats: ProviderStats;
}

export type DigestFocus = 'marketing' | 'review' | 'full';

export interface TurningPoint {
  timestamp?: string;
  kind: 'request' | 'redirect' | 'failure' | 'outcome';
  text: string;
}

export interface SessionDigest {
  session: SessionRef;
  goal: string;
  touchedFiles: string[];
  commands: string[];
  turningPoints: TurningPoint[];
  artifacts: SessionArtifact[];
  markdown: string;
}

export interface UnifiedTimelineEntry {
  timestamp?: string;
  provider: AgentProvider;
  sessionId: string;
  kind: TurnKind;
  summary: string;
}

export interface FileTouch {
  provider: AgentProvider;
  sessionId: string;
  timestamp?: string;
  toolName?: string;
  provenance?: Provenance;
  /** Remote host, when the file was written over ssh/scp. */
  host?: string;
}

export interface WorkspaceDigest {
  workspace: string;
  sessions: SessionRef[];
  collaboratingAgents: AgentProvider[];
  unifiedTimeline: UnifiedTimelineEntry[];
  fileAttribution: Record<string, FileTouch[]>;
  markdown: string;
}

export interface GitCommit {
  sha?: string;
  message: string;
  timestamp?: string;
}

/** Session-level counters — the top tier of the three-level view. */
export interface SessionStats {
  turns: number;
  events: Record<TurnKind, number>;
  /** Distinct files touched — always equals the file ledger's row count. */
  filesChanged: number;
  /** Write actions observed — a file written three times counts three. */
  fileChangeEvents: number;
  /** How the ledger's rows break down — a single label would misdescribe a mix. */
  filesByProvenance: Record<Provenance, number>;
  commands: number;
  errors: number;
  commits: GitCommit[];
  branches: string[];
  models: string[];
  tokens?: TokenUsage;
  artifacts: SessionArtifact[];
  uploads: { name: string; path: string; sizeBytes?: number }[];
  jobs: AsyncJob[];
  jobCounts: Record<JobStatus, number>;
  extras: Record<string, number>;
}

export type UserTurnKind = 'correction' | 'nudge' | 'paste';

export interface UserTurnNote {
  timestamp?: string;
  kind: UserTurnKind;
  text: string;
}

export interface SessionOverview {
  session: SessionRef;
  stats: SessionStats;
  goal: string;
  corrections: UserTurnNote[];
  nudges: number;
  pastes: number;
  anchors: {
    hosts: string[];
    /**
     * Paths merely mentioned in text — always `candidate`, never proof that
     * anything acted on them. `firstTurn`/`lastTurn` express recency only.
     */
    paths: {
      path: string;
      hits: number;
      kind: 'dir' | 'file';
      firstTurn: number;
      lastTurn: number;
      provenance: Provenance;
    }[];
  };
  /** The file ledger itself — the same rows `1session files` prints. */
  writes: FileRecord[];
  pitfalls: string[];
  lastWord: string;
  markdown: string;
}

export type TurnStatus =
  | 'completed'
  | 'unfinished'
  | 'nudged'
  | 'interrupted'
  | 'no_response'
  | 'failed_tail';

export interface TurnSummary {
  no: number;
  /** Whether the turn wrapped up — never a claim about what it achieved. */
  status: TurnStatus;
  /** Every signal that fired. Empty only when the status is `completed`. */
  evidence: string[];
  /** How many pure "keep going" messages followed this turn. */
  nudgeCount: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  prompt: string;
  /** Inclusive event index range this turn spans. */
  events: [number, number];
  eventCount: number;
  files: string[];
  commands: number;
  errors: number;
  outcome: string;
}

export interface TurnDetail {
  summary: TurnSummary;
  events: TurnEvent[];
}
