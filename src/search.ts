import { adapters, listResolvedSessions, parseSince, type ListOptions } from './resolver.js';
import { canonicalizePath, isInside } from './util/paths.js';
import type { SessionRef, TurnEvent, TurnKind } from './types.js';

export interface SearchOptions extends ListOptions {
  /** Bypass the index and parse every candidate from disk. */
  useIndex?: boolean;
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

// ---------------------------------------------------------------------------
// Query planning
// ---------------------------------------------------------------------------

/** Escapes that stand for a class of characters rather than one literal one. */
const CLASS_ESCAPES = new Set('dDwWsSbBnrtfv0xucpPk'.split(''));

/**
 * A substring that every string matching `source` must contain, or `undefined`
 * when no such substring can be proven.
 *
 * Deliberately timid: alternation or groups anywhere and it gives up. A
 * prefilter that is merely usually right would hand back "searched everything"
 * answers that quietly missed rows — the exact failure this store exists to
 * remove — so "no literal" is always the safe reply.
 */
export function mandatoryLiteral(source: string): string | undefined {
  if (/[|()]/.test(source)) return undefined;

  let best = '';
  let run = '';
  const flush = () => {
    if (run.length > best.length) best = run;
    run = '';
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') {
      const next = source[++i];
      if (next === undefined) break;
      if (CLASS_ESCAPES.has(next)) flush();
      else run += next; // an escaped literal character
      continue;
    }
    if (ch === '[') {
      flush();
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      continue;
    }
    // `?`, `*` and `{…}` can make the preceding character disappear, so it
    // stops being mandatory. `+` keeps it (one occurrence at least).
    if (ch === '?' || ch === '*') {
      run = run.slice(0, -1);
      flush();
      continue;
    }
    if (ch === '{') {
      run = run.slice(0, -1);
      flush();
      while (i < source.length && source[i] !== '}') i++;
      continue;
    }
    if (ch === '+' || ch === '.' || ch === '^' || ch === '$') {
      flush();
      continue;
    }
    run += ch;
  }
  flush();
  return best.length >= 2 ? best : undefined;
}

/** True when a character is unaffected by case folding (CJK, digits, punctuation). */
function caseless(ch: string): boolean {
  return ch.toLowerCase() === ch && ch.toUpperCase() === ch;
}

function longestCaselessRun(value: string): string {
  let best = '';
  let run = '';
  for (const ch of value) {
    if (caseless(ch)) {
      run += ch;
      if (run.length > best.length) best = run;
    } else {
      run = '';
    }
  }
  return best;
}

export interface QueryPlan {
  literal?: string;
  fold?: boolean;
}

/**
 * Turns a query into an optional SQL prefilter.
 *
 * Case folding has to agree with what the matcher does. A `gi` regex without
 * the `u` flag folds ASCII only — exactly what SQLite's `lower()` does — so an
 * ASCII literal can be folded on both sides. Anything else falls back to the
 * longest run of characters that have no case at all, where folding is a no-op
 * either way.
 */
export function planQuery(query: string, options: SearchOptions = {}): QueryPlan {
  const raw = options.regex ? mandatoryLiteral(query) : query;
  // A literal spanning a newline could straddle two columns, which the
  // per-column prefilter would miss.
  if (!raw || raw.length < 2 || raw.includes('\n')) return {};
  if (options.caseSensitive) return { literal: raw };
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(raw)) return { literal: raw.toLowerCase(), fold: true };
  const run = longestCaselessRun(raw);
  return run.length >= 2 ? { literal: run } : {};
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface Candidate {
  index: number;
  kind: TurnKind;
  toolName?: string;
  timestamp?: string;
  body: string;
}

function accumulate(
  hits: Map<string, { matches: SearchMatch[]; totalMatches: number }>,
  sessionId: string,
  candidate: Candidate,
  pattern: RegExp,
  context: number,
  maxPerSession: number,
): void {
  if (!candidate.body) return;
  pattern.lastIndex = 0;
  const found = pattern.exec(candidate.body);
  if (!found) return;
  const bucket = hits.get(sessionId) ?? { matches: [], totalMatches: 0 };
  bucket.totalMatches++;
  if (bucket.matches.length < Math.min(maxPerSession, HARD_CAP)) {
    bucket.matches.push({
      index: candidate.index,
      kind: candidate.kind,
      ...(candidate.toolName ? { toolName: candidate.toolName } : {}),
      ...(candidate.timestamp ? { timestamp: candidate.timestamp } : {}),
      excerpt: excerpt(candidate.body, found.index, found[0].length, context),
    });
  }
  hits.set(sessionId, bucket);
}

/**
 * Full-text search across sessions.
 *
 * Scope is never silently trimmed: every session passing `workspace` /
 * `since` / `provider` is searched, and `limit` only caps how many of the
 * resulting hits come back.
 */
export async function searchSessions(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  if (!query.trim()) throw new Error('search query must not be empty');
  const pattern = buildPattern(query, options);
  const context = options.context ?? DEFAULT_CONTEXT;
  const maxPerSession = options.maxPerSession ?? DEFAULT_MAX_PER_SESSION;

  const direct = options.useIndex === false || process.env.SESSION_READER_NO_INDEX === '1';
  const hits = direct
    ? await searchByParsing(query, options, pattern, context, maxPerSession)
    : await searchByIndex(query, options, pattern, context, maxPerSession);

  return hits
    .sort((a, b) => Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? ''))
    .slice(0, options.limit ?? hits.length);
}

/** The oracle: parses every candidate from disk, touching no stored state. */
async function searchByParsing(
  _query: string,
  options: SearchOptions,
  pattern: RegExp,
  context: number,
  maxPerSession: number,
): Promise<SearchHit[]> {
  const kinds = options.kinds?.length ? new Set(options.kinds) : undefined;
  const hits: SearchHit[] = [];
  const handles = await listResolvedSessions({
    ...options,
    limit: Number.POSITIVE_INFINITY,
    scan: Number.POSITIVE_INFINITY,
  });
  for (const handle of handles) {
    const session = await handle.adapter.parse(handle.candidate).catch(() => undefined);
    if (!session) continue;
    const bucket = new Map<string, { matches: SearchMatch[]; totalMatches: number }>();
    for (const turn of session.turns) {
      if (kinds && !kinds.has(turn.kind)) continue;
      accumulate(
        bucket,
        session.ref.id,
        {
          index: turn.index,
          kind: turn.kind,
          ...(turn.toolName ? { toolName: turn.toolName } : {}),
          ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
          body: haystack(turn),
        },
        pattern,
        context,
        maxPerSession,
      );
    }
    const found = bucket.get(session.ref.id);
    if (found) hits.push({ session: session.ref, ...found });
  }
  return hits;
}

/**
 * Index path: candidate rows come from SQL, the verdict stays with the regex.
 *
 * Sessions are never materialized — rebuilding 622 of them into objects cost
 * more than every other part of a search put together.
 */
async function searchByIndex(
  query: string,
  options: SearchOptions,
  pattern: RegExp,
  context: number,
  maxPerSession: number,
): Promise<SearchHit[]> {
  const { openStore } = await import('./store/db.js');
  const { refreshSession } = await import('./store/indexer.js');
  const { searchRows } = await import('./store/rows.js');
  const { refOf } = await import('./store/read.js');
  const db = await openStore();

  const sinceMs = parseSince(options.since);
  const ids: string[] = [];
  for (const adapter of adapters) {
    if (options.provider && adapter.provider !== options.provider) continue;
    for (const candidate of await adapter.listCandidates()) {
      if (sinceMs && candidate.mtimeMs < sinceMs) break; // newest first
      const result = await refreshSession(db, { adapter, candidate }, { edges: false }).catch(
        () => undefined,
      );
      if (result) ids.push(result.id);
    }
  }

  const plan = planQuery(query, options);
  const workspace = options.workspace ? canonicalizePath(options.workspace) : undefined;
  const buckets = new Map<string, { matches: SearchMatch[]; totalMatches: number }>();
  for (const row of searchRows(db, {
    ids,
    ...(workspace ? { workspace } : {}),
    ...(options.kinds?.length ? { kinds: options.kinds } : {}),
    ...(plan.literal ? { literal: plan.literal } : {}),
    ...(plan.fold ? { fold: true } : {}),
  })) {
    const args = row.tool_args_json ?? '';
    accumulate(
      buckets,
      row.session_id,
      {
        index: row.idx,
        kind: row.kind as TurnKind,
        ...(row.tool_name ? { toolName: row.tool_name } : {}),
        ...(row.ts ? { timestamp: row.ts } : {}),
        // Rebuilt exactly as `haystack` does, so an excerpt cannot shift.
        body: [row.text ?? undefined, row.tool_result ?? undefined, args].filter(Boolean).join('\n'),
      },
      pattern,
      context,
      maxPerSession,
    );
  }

  const hits: SearchHit[] = [];
  for (const [id, bucket] of buckets) {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | Parameters<typeof refOf>[0]
      | undefined;
    if (!row) continue;
    const ref = refOf(row);
    if (workspace && !isInside(workspace, ref.workspace ?? '')) continue;
    hits.push({ session: ref, ...bucket });
  }
  return hits;
}
