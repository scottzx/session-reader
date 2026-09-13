import { listResolvedSessions, type ListOptions } from './resolver.js';
import type { SessionRef, TurnEvent, TurnKind } from './types.js';

export interface SearchOptions extends ListOptions {
  /** Restrict to these turn kinds; defaults to all of them. */
  kinds?: TurnKind[];
  /** Treat the query as a regular expression instead of a literal. */
  regex?: boolean;
  caseSensitive?: boolean;
  /** Characters of context kept around each match. */
  context?: number;
  /** Matches recorded per session before scanning moves on. */
  maxPerSession?: number;
}

export interface SearchMatch {
  index: number;
  kind: TurnKind;
  toolName?: string;
  timestamp?: string;
  excerpt: string;
}

export interface SearchHit {
  session: SessionRef;
  matches: SearchMatch[];
  totalMatches: number;
}

const DEFAULT_CONTEXT = 100;
const DEFAULT_MAX_PER_SESSION = 5;
const HARD_CAP = 200;

function buildPattern(query: string, options: SearchOptions): RegExp {
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(source, options.caseSensitive ? 'g' : 'gi');
}

/** Everything in a turn that is worth matching against, as one flat string. */
function haystack(turn: TurnEvent): string {
  const args = turn.toolArgs ? JSON.stringify(turn.toolArgs) : '';
  return [turn.text, turn.toolResult, args].filter(Boolean).join('\n');
}

/** Slices around the match first, then collapses whitespace, so offsets stay valid. */
function excerpt(body: string, at: number, length: number, context: number): string {
  const start = Math.max(0, at - context);
  const end = Math.min(body.length, at + length + context);
  const slice = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < body.length ? '…' : ''}`;
}

/**
 * Full-text scan across sessions. Sessions are parsed in full, so narrow the
 * set with `workspace` / `since` / `provider` before widening `limit`.
 */
export async function searchSessions(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  if (!query.trim()) throw new Error('search query must not be empty');
  const pattern = buildPattern(query, options);
  const kinds = options.kinds?.length ? new Set(options.kinds) : undefined;
  const context = options.context ?? DEFAULT_CONTEXT;
  const maxPerSession = options.maxPerSession ?? DEFAULT_MAX_PER_SESSION;

  const hits: SearchHit[] = [];
  for (const handle of await listResolvedSessions({ ...options, limit: options.limit ?? 30 })) {
    const session = await handle.adapter.parse(handle.candidate).catch(() => undefined);
    if (!session) continue;

    const matches: SearchMatch[] = [];
    let totalMatches = 0;
    for (const turn of session.turns) {
      if (kinds && !kinds.has(turn.kind)) continue;
      const body = haystack(turn);
      if (!body) continue;
      pattern.lastIndex = 0;
      const found = pattern.exec(body);
      if (!found) continue;
      totalMatches++;
      if (matches.length < Math.min(maxPerSession, HARD_CAP)) {
        matches.push({
          index: turn.index,
          kind: turn.kind,
          toolName: turn.toolName,
          timestamp: turn.timestamp,
          excerpt: excerpt(body, found.index, found[0].length, context),
        });
      }
    }
    if (totalMatches) hits.push({ session: session.ref, matches, totalMatches });
  }
  return hits.sort((a, b) => Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? ''));
}
