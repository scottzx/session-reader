import type { TurnEvent } from '../types.js';
/** Records are addressed before normalization, so filtering cannot shift references. */
export declare function sourceEvents(provider: string, sessionId: string): {
    record(raw: Record<string, unknown>, nativeId?: string, messageId?: string, parentId?: string, nativeTurnId?: string): void;
    event(event: Omit<TurnEvent, "id" | "index">): Omit<TurnEvent, "id" | "index">;
};
export declare function existingTitles(...values: [string | undefined, string][]): {
    text: string;
    source: string;
}[];
