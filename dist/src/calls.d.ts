import type { TurnEvent } from './types.js';
/** Missing native IDs mean unknown association, never an adjacent-result guess. */
export declare function toolResults(events: TurnEvent[], call: TurnEvent): TurnEvent[];
export declare function callsIn(events: TurnEvent[]): {
    id: string;
    event: number;
    locator: string | undefined;
    toolName: string | undefined;
    association: "native_id" | "unconfirmed";
    resultEvents: number[];
    status: string;
}[];
