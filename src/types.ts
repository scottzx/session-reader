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
}

export interface TurnBoundary {
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  lastMessage?: string;
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
  /** `inferred` writes were parsed out of a shell command, not a dedicated edit tool. */
  confidence?: 'explicit' | 'inferred';
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
  /** Distinct files touched. */
  filesChanged: number;
  /** Individual change records — a file edited three times counts three. */
  fileChangeEvents: number;
  fileChangeSource: 'provider' | 'inferred';
  commands: number;
  errors: number;
  commits: GitCommit[];
  branches: string[];
  models: string[];
  tokens?: TokenUsage;
  artifacts: SessionArtifact[];
  uploads: { name: string; path: string; sizeBytes?: number }[];
  backgroundTasks: BackgroundTask[];
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
  anchors: { hosts: string[]; paths: { path: string; hits: number; kind: 'dir' | 'file' }[] };
  writes: { path: string; confidence: 'explicit' | 'inferred'; via: string; host?: string }[];
  pitfalls: string[];
  lastWord: string;
  markdown: string;
}

export interface TurnSummary {
  no: number;
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
