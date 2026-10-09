import { type ProviderAdapter } from './provider.js';
/** Prefer the current format when a migration leaves an older transcript alongside it. */
export declare function dshTranscriptPath(dir: string): Promise<string | undefined>;
export declare const dshAdapter: ProviderAdapter;
