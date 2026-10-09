import type { NormalizedSession, TurnDetail, TurnEvent, TurnSummary } from './types.js';
/**
 * Turn boundaries from the user messages that open them.
 *
 * Split out from `turnStarts` so the index path can feed it the same indices
 * straight from SQL without materializing the session: a `T` printed by
 * `search` then means exactly what a `T` printed by `turns` means.
 */
export declare function turnStartsFrom(userEventIndices: number[], eventCount: number): number[];
/**
 * Turn boundaries: codex records them natively, the others start a new turn on
 * every user message.
 */
export declare function turnStarts(session: NormalizedSession): number[];
/**
 * The turn (1-based) an event index falls in, or 0 when it falls before the
 * first one. Turns tile the event stream, so "the last start at or before the
 * index" is the whole rule.
 */
export declare function turnNoAt(starts: number[], index: number): number;
export declare function summarizeTurns(session: NormalizedSession): TurnSummary[];
export declare function turnDetail(session: NormalizedSession, turnNo: number): TurnDetail;
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
export declare const MAX_EVENT_SPAN = 50;
/**
 * `214`, `214-218`, `214,216,218` and any mix, as ascending unique indices.
 *
 * Ranges are clipped to the session — asking for `210-999` on a 300-event
 * session is a reasonable way to say "to the end" — while a bare index is left
 * alone so an out-of-range one still errors naming the number that was typed.
 */
export declare function parseEventSpec(spec: string, eventCount: number): number[];
/** `eventDetail` over a spec: `214`, `214-218`, `214,216,218`. */
export declare function eventDetails(session: NormalizedSession, spec: string): Promise<EventDetail[]>;
/**
 * Tier three: one event with its untruncated payload. Antigravity shortens long
 * step output in the transcript and keeps the full copy under `steps/<n>/`.
 */
export declare function eventDetail(session: NormalizedSession, eventIndex: number): Promise<EventDetail>;
