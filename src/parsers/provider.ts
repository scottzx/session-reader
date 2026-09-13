import type { AgentProvider, NormalizedSession, SessionRef } from '../types.js';

/** A session file found on disk, before any parsing. */
export interface SessionCandidate {
  id: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface ProviderAdapter {
  provider: AgentProvider;
  /** Cheap `stat`-only discovery, newest first. */
  listCandidates(): Promise<SessionCandidate[]>;
  /** Reads just enough of the head of a file to fill a {@link SessionRef}. */
  scanRef(candidate: SessionCandidate): Promise<SessionRef>;
  /** Full parse into ordered turns. */
  parse(candidate: SessionCandidate): Promise<NormalizedSession>;
}

export function toolArgsOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
