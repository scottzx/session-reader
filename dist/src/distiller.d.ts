import type { DigestFocus, NormalizedSession, SessionDigest, TurnEvent } from './types.js';
/** Paths a tool call wrote to, including files written through the shell. */
export declare function editedFiles(turn: TurnEvent, workspace?: string): string[];
export declare function shellCommand(turn: TurnEvent): string | undefined;
export declare function distillSession(session: NormalizedSession, options?: {
    focus?: DigestFocus;
}): SessionDigest;
