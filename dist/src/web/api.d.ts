import type { ServerResponse } from 'node:http';
import type { NormalizedSession } from '../types.js';
export interface SessionApiOptions {
    /** Used when the client asks for scope=cwd but does not send ?workspace=. */
    fallbackCwd: string;
}
export declare function resolveListWorkspace(scope: string | null, workspace: string | null, fallbackCwd: string): string | undefined;
/** Chat-preview turns. Built only after the user clicks a session. */
export declare function previewTurns(normalized: NormalizedSession): {
    no: number;
    turn: number;
    status: import("../types.js").TurnStatus;
    prompt: string;
    userPrompt: string;
    messages: import("../types.js").TurnEvent[];
    outcome: string;
    assistantReply: string;
    thinking: string;
    thinkingBlocks: never[];
    toolCalls: {
        id: string;
        event: number;
        locator: string | undefined;
        toolName: string | undefined;
        association: "native_id" | "unconfirmed";
        resultEvents: number[];
        status: string;
    }[];
    files: string[];
    commands: number;
    errors: number;
    startedAt: string | undefined;
    endedAt: string | undefined;
    durationMs: number | undefined;
}[];
export declare function sessionPreview(sessionId: string): Promise<{
    turns: {
        no: number;
        turn: number;
        status: import("../types.js").TurnStatus;
        prompt: string;
        userPrompt: string;
        messages: import("../types.js").TurnEvent[];
        outcome: string;
        assistantReply: string;
        thinking: string;
        thinkingBlocks: never[];
        toolCalls: {
            id: string;
            event: number;
            locator: string | undefined;
            toolName: string | undefined;
            association: "native_id" | "unconfirmed";
            resultEvents: number[];
            status: string;
        }[];
        files: string[];
        commands: number;
        errors: number;
        startedAt: string | undefined;
        endedAt: string | undefined;
        durationMs: number | undefined;
    }[];
    ref: import("../types.js").SessionRef;
    stats: import("../types.js").ProviderStats;
    overview: import("../types.js").SessionOverview;
    files: {
        displayPath: string;
        path: string;
        host?: string;
        operation: string;
        turn: number;
        eventIndex: number;
        timestamp?: string;
        provenance: import("../types.js").Provenance;
        extractor: string;
        group: import("../types.js").FileGroup;
    }[];
}>;
export declare function listSessionsForUi(options: {
    limit?: number;
    offset?: number;
    provider?: string;
    since?: string;
    workspace?: string;
}): Promise<import("../types.js").SessionRef[]>;
/**
 * Shared JSON API used by the DSH plugin and `1session web`.
 * Path is already stripped of `/api/session-reader`. Returns false if unmatched.
 */
export declare function handleSessionApi(pathname: string, url: URL, res: ServerResponse, options: SessionApiOptions): Promise<boolean>;
