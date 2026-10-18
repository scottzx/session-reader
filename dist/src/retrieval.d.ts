import { type SearchOptions, type SearchHit } from './search.js';
import type { SemanticOptions, SemanticStatus } from './semantic/index.js';
export interface RetrievalOptions extends SearchOptions {
    mode?: 'keyword' | 'semantic';
    model?: SemanticOptions['model'];
    includeSelf?: boolean;
}
export interface RetrievalResult {
    hits: SearchHit[];
    retrieval: {
        mode: 'keyword';
    } | SemanticStatus;
}
/** Shared opt-in orchestration; existing deterministic searchSessions is unchanged. */
export declare function retrieveSessions(query: string, options?: RetrievalOptions): Promise<RetrievalResult>;
