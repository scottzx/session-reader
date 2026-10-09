/** DSH admission delegates native execution to the installed ACP plugin. */
import type { AgentProvider, SessionRef } from '../types.js';
import { type DshSessionEvent } from './adapter.js';
export interface Availability {
    available: boolean;
    agent?: string;
    reason?: string;
}
interface OpenResult {
    success: true;
    dshSessionId: string;
    workspace?: string;
    workspaceId?: string;
    agent?: string;
    continuation: 'native' | 'dsh';
    writable?: boolean;
    blocked?: 'active-writer';
}
interface AcpSessions {
    availability(provider: string): Promise<Availability>;
    importSession(input: {
        provider: string;
        nativeSessionId: string;
        cwd: string;
        events: DshSessionEvent[];
    }): Promise<OpenResult>;
}
export interface OpenContext {
    get(key: 'oneagentsAcpSessions'): AcpSessions | undefined;
    sessionController?: {
        resolveAgent(id: string): Promise<{
            error: Error;
        } | {
            agent: {
                session: {
                    header: {
                        cwd?: string;
                    };
                };
            };
        }>;
    };
    workspaceRegistry?: {
        create(cwd: string): Promise<{
            id: string;
            attachSession(id: string): Promise<void>;
        }>;
    };
}
export interface OpenRequest {
    sessionId: string;
    provider?: AgentProvider;
}
/** Resolve the source once; missing/unsupported ACP leaves history readable without creating a DSH session. */
export declare function continuationAvailability(ctx: OpenContext, ref: Pick<SessionRef, 'provider'>): Promise<Availability>;
/** Open DSH's original identity or attach native history; ACP separately reports writing availability. */
export declare function openSessionInDsh(ctx: OpenContext, request: OpenRequest): Promise<OpenResult>;
export {};
