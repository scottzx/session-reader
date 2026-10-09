import { type ProviderAdapter } from './provider.js';
/**
 * The directory name is the percent-encoded cwd, so it decodes back exactly —
 * unlike Claude's lossy slug, this is an answer rather than a prefilter.
 */
export declare function workspaceFromProjectDir(name: string): string;
export declare const grokAdapter: ProviderAdapter;
