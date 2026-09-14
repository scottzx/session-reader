import { adapters, listResolvedSessions, parseSince, type ListOptions } from './resolver.js';
import { turnNoAt, turnStarts } from './turns.js';
import { canonicalizePath, isInside } from './util/paths.js';
import type { NormalizedSession, SessionRef, TurnEvent, TurnKind } from './types.js';

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
  /**
   * The session doing the searching, so its own live transcript can be marked.
   * Defaults to `SESSION_READER_CALLER_SESSION`; pass `''` to disable.
   */
  selfSessionId?: string;
}

export interface SearchMatch {
  index: number;
  /**
   * The turn this event belongs to — the other half of the drill-down handle,
   * so `T<turn> · E<index>` maps straight onto `turn <id> <turn> --event <index>`.
   * 0 when the session records no turn that contains the event.
   */
  turn: number;
  kind: TurnKind;
  toolName?: string;
  timestamp?: string;
  excerpt: string;
}

export interface SearchHit {
  session: SessionRef;
  matches: SearchMatch[];
  totalMatches: number;
  /** Matches dropped because they were this very search echoing back. */
  suppressed?: number;
  /**
   * The searcher's own session: either the injected caller id, or a session
   * whose every match was the running invocation. Never removed from the
   * result — callers hide it, so the count stays reportable.
   */
  self?: boolean;
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

export interface Candidate {
  index: number;
  kind: TurnKind;
  toolName?: string;
  timestamp?: string;
  body: string;
}

interface Bucket {
  matches: SearchMatch[];
  totalMatches: number;
  suppressed: number;
}

// ---------------------------------------------------------------------------
// The searcher's own footprint
// ---------------------------------------------------------------------------

/**
 * How recent a `1session` invocation has to be to be this very search rather
 * than a historical one. The agent's tool call is written to its transcript
 * seconds before the command runs, so the window only has to survive the
 * indexing sweep — but a past session that genuinely ran the same query must
 * stay a real hit, which is what keeps this narrow.
 */
const SELF_ECHO_WINDOW_MS = 5 * 60_000;
/** How far after the invocation its own output may land, as in `commandLedger`. */
const RESULT_SPAN = 3;
const INVOCATION = /(?:^|[\s"'`/])1session\s/;

/**
 * A `1session` invocation written in the last few minutes.
 *
 * Only the live transcript can hold one: a session that ended yesterday cannot
 * have an event timestamped now, so the window is what separates "this
 * investigation, happening" from "someone once ran this", and no past session
 * is ever touched by it.
 */
function isRunningInvocation(candidate: Candidate, now: number): boolean {
  if (candidate.kind !== 'tool_call' || !candidate.timestamp) return false;
  const at = Date.parse(candidate.timestamp);
  if (!Number.isFinite(at) || at < now - SELF_ECHO_WINDOW_MS || at > now + 60_000) return false;
  return INVOCATION.test(candidate.body);
}

/**
 * Folds the Read Plane's own footprint out of one session: an invocation
 * running right now, and the result carrying what it printed.
 *
 * It deliberately does not require the invocation to carry *this* query. A
 * `1session` call from a minute ago prints other sessions' content verbatim,
 * so it matches queries it never mentioned — and whatever it echoed is still
 * in the session it was quoting from, where the search finds it properly, with
 * a handle that drills down to the real thing instead of to a screenful of
 * this tool's output.
 *
 * Stateful because the second half is only knowable from the first, so it is
 * built fresh per session and fed events in index order — which both search
 * paths already produce.
 */
export function echoFolder(now: number): (candidate: Candidate) => boolean {
  let lastEcho = Number.NEGATIVE_INFINITY;
  return (candidate) => {
    if (isRunningInvocation(candidate, now)) {
      lastEcho = candidate.index;
      return true;
    }
    return candidate.kind === 'tool_result' && candidate.index - lastEcho <= RESULT_SPAN;
  };
}

/**
 * Whether a session is the one running the search. Accepts the canonical
 * `provider:native_id`, the bare native id, or a 6+ character prefix of it —
 * the same spellings `resolveSession` takes.
 */
export function isCallerSession(ref: SessionRef, callerId: string | undefined): boolean {
  const caller = callerId?.trim().toLowerCase();
  if (!caller) return false;
  const native = ref.id.toLowerCase();
  const canonical = `${ref.provider}:${native}`;
  const bare = caller.includes(':') ? caller.slice(caller.indexOf(':') + 1) : caller;
  return caller === canonical || bare === native || (bare.length >= 6 && native.startsWith(bare));
}

function accumulate(
  hits: Map<string, Bucket>,
  sessionId: string,
  candidate: Candidate,
  pattern: RegExp,
  context: number,
  maxPerSession: number,
  echo: (candidate: Candidate) => boolean,
): void {
  if (!candidate.body) return;
  pattern.lastIndex = 0;
  const found = pattern.exec(candidate.body);
  if (!found) return;
  const bucket = hits.get(sessionId) ?? { matches: [], totalMatches: 0, suppressed: 0 };
  hits.set(sessionId, bucket);
  if (echo(candidate)) {
    bucket.suppressed++;
    return;
  }
  bucket.totalMatches++;
  if (bucket.matches.length < Math.min(maxPerSession, HARD_CAP)) {
    bucket.matches.push({
      index: candidate.index,
      turn: 0, // filled in once the session's turn boundaries are known
      kind: candidate.kind,
      ...(candidate.toolName ? { toolName: candidate.toolName } : {}),
      ...(candidate.timestamp ? { timestamp: candidate.timestamp } : {}),
      excerpt: excerpt(candidate.body, found.index, found[0].length, context),
    });
  }
}

/** Stamps the drill-down handle onto every match of one session. */
function assignTurns(matches: SearchMatch[], starts: number[]): void {
  for (const match of matches) match.turn = turnNoAt(starts, match.index);
}

/** A bucket as it leaves the search: empty ones only survive to be counted. */
function toHit(session: SessionRef, bucket: Bucket, caller: string | undefined): SearchHit {
  const self = isCallerSession(session, caller) || (bucket.totalMatches === 0 && bucket.suppressed > 0);
  return {
    session,
    matches: bucket.matches,
    totalMatches: bucket.totalMatches,
    ...(bucket.suppressed ? { suppressed: bucket.suppressed } : {}),
    ...(self ? { self: true } : {}),
  };
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
  const now = Date.now();
  const plan: MatchPlan = {
    pattern,
    context,
    maxPerSession,
    newEchoFolder: () => echoFolder(now),
    caller: options.selfSessionId ?? process.env.SESSION_READER_CALLER_SESSION,
  };

  const direct = options.useIndex === false || process.env.SESSION_READER_NO_INDEX === '1';
  const hits = direct
    ? await searchByParsing(options, plan)
    : await searchByIndex(query, options, plan);

  hits.sort((a, b) => Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? ''));
  // `limit` caps the sessions a caller has to read, so it counts the ones that
  // will actually be shown; a folded self-hit carries nothing but its tally and
  // must not push a real session out of the answer.
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let shown = 0;
  return hits.filter((hit) => (hit.self ? true : ++shown <= limit));
}

/** Everything the matcher needs that does not change between sessions. */
interface MatchPlan {
  pattern: RegExp;
  context: number;
  maxPerSession: number;
  /** One folder per session: the state it keeps must not leak across them. */
  newEchoFolder: () => (candidate: Candidate) => boolean;
  caller: string | undefined;
}

/** The oracle: parses every candidate from disk, touching no stored state. */
async function searchByParsing(options: SearchOptions, plan: MatchPlan): Promise<SearchHit[]> {
  const kinds = options.kinds?.length ? new Set(options.kinds) : undefined;
  const hits: SearchHit[] = [];
  const handles = await listResolvedSessions({
    ...options,
    limit: Number.POSITIVE_INFINITY,
    scan: Number.POSITIVE_INFINITY,
  });
  for (const handle of handles) {
    const session: NormalizedSession | undefined = await handle.adapter
      .parse(handle.candidate)
      .catch(() => undefined);
    if (!session) continue;
    const bucket = new Map<string, Bucket>();
    const echo = plan.newEchoFolder();
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
        plan.pattern,
        plan.context,
        plan.maxPerSession,
        echo,
      );
    }
    const found = bucket.get(session.ref.id);
    if (!found) continue;
    assignTurns(found.matches, turnStarts(session));
    hits.push(toHit(session.ref, found, plan.caller));
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
  plan: MatchPlan,
): Promise<SearchHit[]> {
  const { openStore } = await import('./store/db.js');
  const { refreshSession } = await import('./store/indexer.js');
  const { searchRows } = await import('./store/rows.js');
  const { refOf, turnStartsOf } = await import('./store/read.js');
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

  const prefilter = planQuery(query, options);
  const workspace = options.workspace ? canonicalizePath(options.workspace) : undefined;
  const buckets = new Map<string, Bucket>();
  let folding = { sessionId: '', echo: plan.newEchoFolder() };
  for (const row of searchRows(db, {
    ids,
    ...(workspace ? { workspace } : {}),
    ...(options.kinds?.length ? { kinds: options.kinds } : {}),
    ...(prefilter.literal ? { literal: prefilter.literal } : {}),
    ...(prefilter.fold ? { fold: true } : {}),
  })) {
    // `searchRows` orders by (session_id, idx), which is what the folder needs.
    if (row.session_id !== folding.sessionId) {
      folding = { sessionId: row.session_id, echo: plan.newEchoFolder() };
    }
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
      plan.pattern,
      plan.context,
      plan.maxPerSession,
      folding.echo,
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
    // Only the sessions that actually matched pay for this — a handful of
    // index lookups, not the 622-session rebuild the row path exists to avoid.
    assignTurns(bucket.matches, turnStartsOf(db, id, row.event_count));
    hits.push(toHit(ref, bucket, plan.caller));
  }
  return hits;
}
