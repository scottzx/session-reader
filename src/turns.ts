import { readFullStepOutput } from './parsers/antigravity.js';
import { oneLine } from './util/text.js';
import { fileWrites, rawCommand, resolveWritePath } from './writes.js';
import type { NormalizedSession, TurnDetail, TurnEvent, TurnSummary } from './types.js';

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

export function summarizeTurns(session: NormalizedSession): TurnSummary[] {
  const starts = boundaries(session);
  const workspace = session.ref.workspace;
  const declared = session.stats.turnBoundaries;

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
    const outcome = [...events].reverse().find((event) => event.kind === 'assistant' && event.text?.trim());
    const startedAt = events[0]?.timestamp;
    const endedAt = events.at(-1)?.timestamp;
    // Provider-declared turns are fewer than user messages, so match them by
    // time rather than by position — indexing them would misalign durations.
    const native = declared.find((boundary) => {
      if (!boundary.startedAt || !startedAt || !endedAt) return false;
      const at = Date.parse(boundary.startedAt);
      return at >= Date.parse(startedAt) && at <= Date.parse(endedAt);
    });
    const durationMs =
      native?.durationMs ??
      (startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || undefined : undefined);

    return {
      no: i + 1,
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
