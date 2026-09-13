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
 * Turn boundaries: codex records them natively, the others start a new turn on
 * every user message.
 */
function boundaries(session: NormalizedSession): number[] {
  const starts = session.turns
    .filter((turn) => turn.kind === 'user' && turn.text?.trim())
    .map((turn) => turn.index);
  if (!starts.length && session.turns.length) return [0];
  // Anything before the first user message belongs to turn 1.
  if (starts[0] !== 0 && session.turns.length) starts[0] = 0;
  return starts;
}

/**
 * Providers fire `task_started` a few seconds *before* the first event of the
 * turn it opens, so a boundary belongs to the next turn that starts, not to
 * the turn whose window happens to contain it.
 */
function boundariesByTurn(
  declared: TurnBoundary[],
  turnStarts: (string | undefined)[],
): Map<number, TurnBoundary[]> {
  const byTurn = new Map<number, TurnBoundary[]>();
  for (const boundary of declared) {
    if (!boundary.startedAt) continue;
    const at = Date.parse(boundary.startedAt);
    let owner = turnStarts.findIndex((start) => start !== undefined && Date.parse(start) >= at);
    if (owner === -1) owner = turnStarts.length - 1;
    const list = byTurn.get(owner) ?? [];
    list.push(boundary);
    byTurn.set(owner, list);
  }
  return byTurn;
}

export function summarizeTurns(session: NormalizedSession): TurnSummary[] {
  const starts = boundaries(session);
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
