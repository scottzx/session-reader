import { readFullStepOutput } from './parsers/antigravity.js';
import { oneLine } from './util/text.js';
import { fileWrites, rawCommand, resolveWritePath } from './writes.js';
import { classifyUserTurn } from './classify.js';
import type {
  NormalizedSession,
  TurnBoundary,
  TurnDetail,
  TurnEvent,
  TurnStatus,
  TurnSummary,
} from './types.js';

/**
 * Whether a turn wrapped up — never a claim about what it achieved.
 * Every non-`completed` verdict must name the signal that produced it.
 */
function assessTurn(
  events: TurnEvent[],
  native: TurnBoundary | undefined,
  nextPrompt: TurnEvent | undefined,
  nudgeCount: number,
): { status: TurnStatus; evidence: string[] } {
  const evidence: string[] = [];
  let status: TurnStatus = 'completed';

  const assistantTail = [...events].reverse().find((event) => event.kind === 'assistant' && event.text?.trim());
  const nonUser = events.filter((event) => event.kind !== 'user');
  const openCalls = events.filter(
    (event) =>
      event.kind === 'tool_call' &&
      !events.some((other) => other.kind === 'tool_result' && other.index > event.index),
  );
  const last = events.at(-1);

  if (!nonUser.length) {
    status = 'no_response';
    evidence.push('该轮除用户消息外没有任何助理事件');
  }
  if (native && !native.completed) {
    status = 'unfinished';
    evidence.push(`provider 记录了 task_started 但没有配对的 task_complete${native.id ? `（turn ${native.id.slice(0, 13)}）` : ''}`);
  }
  if (openCalls.length) {
    if (status === 'completed') status = 'interrupted';
    evidence.push(`事件 #${openCalls[0]!.index} 的工具调用没有对应结果`);
  }
  if (last?.kind === 'tool_result' && (last.exitCode ?? 0) !== 0 && !assistantTail) {
    if (status === 'completed') status = 'failed_tail';
    evidence.push(`以 exit ${last.exitCode} 的结果收尾，其后没有助理回复`);
  }
  if (nudgeCount > 0) {
    if (status === 'completed') status = 'nudged';
    evidence.push(
      `下一轮是纯推进指令${nudgeCount > 1 ? `，连续 ${nudgeCount} 次` : ''}（"${nextPrompt?.text?.trim().slice(0, 20) ?? ''}"）`,
    );
  }
  return { status, evidence };
}

/**
 * Turn boundaries from the user messages that open them.
 *
 * Split out from `turnStarts` so the index path can feed it the same indices
 * straight from SQL without materializing the session: a `T` printed by
 * `search` then means exactly what a `T` printed by `turns` means.
 */
export function turnStartsFrom(userEventIndices: number[], eventCount: number): number[] {
  const starts = [...userEventIndices];
  if (!starts.length) return eventCount ? [0] : [];
  // Anything before the first user message belongs to turn 1.
  if (starts[0] !== 0 && eventCount) starts[0] = 0;
  return starts;
}

/**
 * Turn boundaries: codex records them natively, the others start a new turn on
 * every user message.
 */
export function turnStarts(session: NormalizedSession): number[] {
  return turnStartsFrom(
    session.turns.filter((turn) => turn.kind === 'user' && turn.text?.trim()).map((turn) => turn.index),
    session.turns.length,
  );
}

/**
 * The turn (1-based) an event index falls in, or 0 when it falls before the
 * first one. Turns tile the event stream, so "the last start at or before the
 * index" is the whole rule.
 */
export function turnNoAt(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= index) {
      found = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Providers fire `task_started` a few seconds *before* the first event of the
 * turn it opens, so a boundary belongs to the next turn that starts, not to
 * the turn whose window happens to contain it.
 */
function boundariesByTurn(
  declared: TurnBoundary[],
  startTimes: (string | undefined)[],
): Map<number, TurnBoundary[]> {
  const byTurn = new Map<number, TurnBoundary[]>();
  for (const boundary of declared) {
    if (!boundary.startedAt) continue;
    const at = Date.parse(boundary.startedAt);
    let owner = startTimes.findIndex((start) => start !== undefined && Date.parse(start) >= at);
    if (owner === -1) owner = startTimes.length - 1;
    const list = byTurn.get(owner) ?? [];
    list.push(boundary);
    byTurn.set(owner, list);
  }
  return byTurn;
}

export function summarizeTurns(session: NormalizedSession): TurnSummary[] {
  const starts = turnStarts(session);
  const workspace = session.ref.workspace;
  const declared = session.stats.turnBoundaries;
  const nativeByTurn = boundariesByTurn(
    declared,
    starts.map((start) => session.turns[start]?.timestamp),
  );

  return starts.map((start, i) => {
    const end = (starts[i + 1] ?? session.turns.length) - 1;
    const events = session.turns.slice(start, end + 1);
    const files = new Set<string>();
    let commands = 0;
    let errors = 0;
    for (const event of events) {
      for (const write of fileWrites(event)) files.add(resolveWritePath(write, workspace));
      if (rawCommand(event)) commands++;
      if (event.kind === 'tool_result' && event.isError) errors++;
    }
    const prompt = events.find((event) => event.kind === 'user' && event.text?.trim());
    // Count the run of pure "keep going" messages that follows this turn.
    let nudgeCount = 0;
    for (let k = i + 1; k < starts.length; k++) {
      const next = session.turns[starts[k]!];
      if (next?.kind === 'user' && next.text && classifyUserTurn(next.text) === 'nudge') nudgeCount++;
      else break;
    }
    const nextPrompt = session.turns[starts[i + 1] ?? -1];
    const outcome = [...events].reverse().find((event) => event.kind === 'assistant' && event.text?.trim());
    const startedAt = events[0]?.timestamp;
    const endedAt = events.at(-1)?.timestamp;
    const owned = nativeByTurn.get(i) ?? [];
    // A turn is only as finished as its least finished declared boundary.
    const native = owned.find((boundary) => !boundary.completed) ?? owned[0];
    const durationMs =
      (owned.length === 1 ? native?.durationMs : undefined) ??
      (startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || undefined : undefined);

    const { status, evidence } = assessTurn(events, native, nextPrompt, nudgeCount);

    return {
      no: i + 1,
      status,
      evidence,
      nudgeCount,
      startedAt,
      endedAt,
      ...(durationMs ? { durationMs } : {}),
      prompt: oneLine(prompt?.text, 120) || '（无用户消息）',
      events: [start, end],
      eventCount: events.length,
      files: [...files],
      commands,
      errors,
      outcome: oneLine(outcome?.text ?? native?.lastMessage, 120),
    };
  });
}

export function turnDetail(session: NormalizedSession, turnNo: number): TurnDetail {
  const summaries = summarizeTurns(session);
  const summary = summaries[turnNo - 1];
  if (!summary) throw new Error(`no turn ${turnNo} (session has ${summaries.length})`);
  return { summary, events: session.turns.slice(summary.events[0], summary.events[1] + 1) };
}

export interface EventDetail extends TurnEvent {
  /** Full text, recovered from the provider's side files when truncated. */
  fullText?: string;
  /** Set when the transcript is short and the full copy could not be found. */
  truncationNote?: string;
}

/**
 * How many events one `--event` spec may expand to. Reading a tool call with
 * its result and the assistant's verdict takes three; a spec asking for
 * hundreds wanted `turn <n>` instead, and silently truncating would be worse
 * than saying so.
 */
export const MAX_EVENT_SPAN = 50;

/**
 * `214`, `214-218`, `214,216,218` and any mix, as ascending unique indices.
 *
 * Ranges are clipped to the session — asking for `210-999` on a 300-event
 * session is a reasonable way to say "to the end" — while a bare index is left
 * alone so an out-of-range one still errors naming the number that was typed.
 */
export function parseEventSpec(spec: string, eventCount: number): number[] {
  const indices = new Set<number>();
  for (const part of spec.split(',').map((piece) => piece.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b) as [number, number];
      for (let i = Math.max(0, from); i <= Math.min(to, eventCount - 1); i++) indices.add(i);
      continue;
    }
    if (!/^\d+$/.test(part)) {
      throw new Error(`--event 无法解析：${part}（用 214、214-218 或 214,216,218）`);
    }
    indices.add(Number(part));
  }
  if (!indices.size) throw new Error(`--event ${spec} 不含该会话的任何事件（0–${eventCount - 1}）`);
  if (indices.size > MAX_EVENT_SPAN) {
    throw new Error(
      `--event ${spec} 展开为 ${indices.size} 个事件，超过上限 ${MAX_EVENT_SPAN}；` +
        `缩小区间，或用 1session turn <id> <轮次> 看整轮概要`,
    );
  }
  return [...indices].sort((a, b) => a - b);
}

/** `eventDetail` over a spec: `214`, `214-218`, `214,216,218`. */
export async function eventDetails(session: NormalizedSession, spec: string): Promise<EventDetail[]> {
  const indices = parseEventSpec(spec, session.turns.length);
  const details: EventDetail[] = [];
  for (const index of indices) details.push(await eventDetail(session, index));
  return details;
}

/**
 * Tier three: one event with its untruncated payload. Antigravity shortens long
 * step output in the transcript and keeps the full copy under `steps/<n>/`.
 */
export async function eventDetail(session: NormalizedSession, eventIndex: number): Promise<EventDetail> {
  const event = session.turns[eventIndex];
  if (!event) throw new Error(`no event ${eventIndex} (session has ${session.turns.length})`);
  if (!event.truncated || session.ref.provider !== 'antigravity' || event.sourceIndex === undefined) {
    return { ...event };
  }
  const full = await readFullStepOutput(session.ref.path, event.sourceIndex);
  return full
    ? { ...event, fullText: full }
    : { ...event, truncationNote: `transcript 已截断，steps/${event.sourceIndex}/output.txt 不存在` };
}
