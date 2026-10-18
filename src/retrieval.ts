import { searchSessions, type SearchOptions, type SearchHit } from './search.js';
import type { SemanticOptions, SemanticStatus } from './semantic/index.js';

export interface RetrievalOptions extends SearchOptions {
  mode?: 'keyword' | 'semantic';
  model?: SemanticOptions['model'];
  includeSelf?: boolean;
}
export interface RetrievalResult { hits: SearchHit[]; retrieval: { mode: 'keyword' } | SemanticStatus }

/** Shared opt-in orchestration; existing deterministic searchSessions is unchanged. */
export async function retrieveSessions(query: string, options: RetrievalOptions = {}): Promise<RetrievalResult> {
  const mode = options.mode ?? 'keyword';
  if (mode === 'keyword') return { hits: await searchSessions(query, options), retrieval: { mode } };
  if (mode !== 'semantic') throw Object.assign(new Error('mode must be keyword or semantic'), { code: 'SEMANTIC_INVALID_QUERY' });
  const { searchSemanticSessions } = await import('./semantic/index.js');
  return searchSemanticSessions(query, options);
}
