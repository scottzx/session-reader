import { type EmbeddingAlias, type EmbeddingProfile, type EmbeddingResult, type SharedEmbeddingClient } from '@1agents/artifact-index/embeddings';
import { type SearchOptions, type SearchHit } from '../search.js';
export type { EmbeddingAlias };
export interface SemanticClient extends Pick<SharedEmbeddingClient, 'getProfile' | 'embedText' | 'embedQuery'> {
    getTextProfile?(alias: EmbeddingAlias, options?: {
        signal?: AbortSignal;
    }): Promise<EmbeddingProfile>;
    embedDocuments?(texts: string[], profile: EmbeddingProfile, options?: {
        signal?: AbortSignal;
    }): Promise<EmbeddingResult>;
}
export interface SemanticOptions extends SearchOptions {
    model?: EmbeddingAlias;
    dbPath?: string;
    sourceDbPath?: string;
    client?: SemanticClient;
    signal?: AbortSignal;
    includeSelf?: boolean;
}
export interface SemanticStatus {
    mode: 'semantic';
    model: EmbeddingAlias;
    profile: EmbeddingProfile | null;
    chunker: string;
    coverageBasis: 'structural-index-snapshot';
    rawSourceDiscovery: false;
    totalSessions: number;
    indexedSessions: number;
    totalEvents: number;
    pendingEvents: number;
    skippedEvents: number;
    indexedChunks: number;
    partial: boolean;
    updatedAt: string | null;
    lastBuild: Record<string, unknown> | null;
}
export declare const semanticDbPath: () => string;
export declare function semanticStatus(o?: SemanticOptions): Promise<SemanticStatus>;
/** Explicit local eviction across model profiles. Does not remove or change source transcripts. */
export declare function forgetSemanticSession(sessionId: string, options?: Pick<SemanticOptions, 'dbPath'>): Promise<{
    sessionId: string;
    removedChunks: number;
}>;
/** Incremental encoding and atomic activation; failed batches leave the last generation intact. */
export declare function buildSemanticIndex(o?: SemanticOptions): Promise<SemanticStatus & {
    encodedVectors: number;
    reusedVectors: number;
}>;
export declare function searchSemanticSessions(query: string, o?: SemanticOptions): Promise<{
    hits: SearchHit[];
    retrieval: SemanticStatus;
}>;
