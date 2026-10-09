import { type LoadOptions } from './resolver.js';
import type { SessionRef, TurnEvent, TurnSummary } from './types.js';
export interface ReadOptions extends LoadOptions {
    cursor?: string;
    /** A page budget in characters; token counts vary by model. */
    maxChars?: number;
}
export interface ContentItem {
    index: number;
    kind: TurnEvent['kind'];
    locator?: string;
    callId?: string;
    toolName?: string;
    timestamp?: string;
    source?: TurnEvent['source'];
    field: 'text' | 'arguments' | 'result' | 'record';
    content: string;
    offset: number;
    totalChars: number;
    providerTruncated?: boolean;
    recovered?: boolean;
    truncationNote?: string;
}
/** Cursors bind to the selected originals; appended unrelated records do not invalidate them. */
export declare function contentPage(events: TurnEvent[], options?: ReadOptions): {
    nextCursor?: string | undefined;
    items: ContentItem[];
};
/** Reads a batch of turn ranges without rebuilding all indexed session events. */
export declare function readTurns(id: string, spec: string, options?: ReadOptions): Promise<{
    nextCursor?: string | undefined;
    items: ContentItem[];
    session: SessionRef;
    summaries: TurnSummary[];
    tools: {
        id: string;
        event: number;
        locator: string | undefined;
        toolName: string | undefined;
        association: "native_id" | "unconfirmed";
        resultEvents: number[];
        status: string;
    }[];
}>;
/** The directory is persisted during indexing; listing it need not hydrate every event. */
export declare function readTurnDirectory(id: string, options?: LoadOptions): Promise<{
    session: SessionRef;
    eventCount: number;
    turns: TurnSummary[];
}>;
export declare function readEvents(id: string, selectors: string[], options?: ReadOptions): Promise<{
    nextCursor?: string | undefined;
    items: ContentItem[];
    session: SessionRef;
}>;
/** Returns the exact JSONL records, including envelopes omitted by the dialogue view. */
export declare function readOriginalRecords(id: string, selectors: string[], options?: ReadOptions): Promise<{
    items: {
        kind: import("./types.js").TurnKind;
        field: "record";
        index: number;
        locator?: string;
        callId?: string;
        toolName?: string;
        timestamp?: string;
        source?: TurnEvent["source"];
        content: string;
        offset: number;
        totalChars: number;
        providerTruncated?: boolean;
        recovered?: boolean;
        truncationNote?: string;
    }[];
    nextCursor?: string | undefined;
    session: SessionRef;
}>;
export declare function readCall(id: string, callId: string, options?: ReadOptions): Promise<{
    nextCursor?: string | undefined;
    items: ContentItem[];
    session: SessionRef;
    association: string;
}>;
export declare function readArtifact(id: string, artifactPath: string, options?: ReadOptions): Promise<{
    nextCursor?: string | undefined;
    items: ContentItem[];
    session: SessionRef;
    artifact: {
        name: string;
        path: string;
        kind: "markdown" | "image" | "other";
    };
}>;
