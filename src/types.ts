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
}

/** A markdown file written next to the session (Antigravity plans / walkthroughs). */
export interface SessionArtifact {
  name: string;
  path: string;
  content?: string;
}

export interface NormalizedSession {
  ref: SessionRef;
  turns: TurnEvent[];
  artifacts: SessionArtifact[];
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
}

export interface WorkspaceDigest {
  workspace: string;
  sessions: SessionRef[];
  collaboratingAgents: AgentProvider[];
  unifiedTimeline: UnifiedTimelineEntry[];
  fileAttribution: Record<string, FileTouch[]>;
  markdown: string;
}
