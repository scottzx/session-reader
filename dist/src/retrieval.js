import { searchSessions } from './search.js';
/** Shared opt-in orchestration; existing deterministic searchSessions is unchanged. */
export async function retrieveSessions(query, options = {}) {
    const mode = options.mode ?? 'keyword';
    if (mode === 'keyword')
        return { hits: await searchSessions(query, options), retrieval: { mode } };
    if (mode !== 'semantic')
        throw Object.assign(new Error('mode must be keyword or semantic'), { code: 'SEMANTIC_INVALID_QUERY' });
    const { searchSemanticSessions } = await import('./semantic/index.js');
    return searchSemanticSessions(query, options);
}
