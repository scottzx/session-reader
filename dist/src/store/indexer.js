import { summarizeTurns } from '../turns.js';
import { deriveEdges } from './edges.js';
import { deriveFacts } from './facts.js';
import { readSession, sessionRow } from './read.js';
import { EDGE_VERSION, EXTRACTOR_VERSION, PARSER_VERSION } from './schema.js';
import { canonicalId, fingerprintOf, writeSession } from './write.js';
/**
 * Brings one session's index up to date and returns it.
 *
 * The three layers are invalidated independently: only a changed fingerprint
 * or a new `PARSER_VERSION` costs a file read. A new `EXTRACTOR_VERSION` or
 * `EDGE_VERSION` re-derives from the stored events alone.
 */
export async function indexSession(db, handle, options = {}) {
    const result = await refreshSession(db, handle, options);
    const session = result.session ?? readSession(db, sessionRow(db, result.id));
    return { id: result.id, action: result.action, session };
}
/**
 * The same work without materializing the session.
 *
 * A caller that only needs the index to be current — search, for one — pays a
 * stat and a 64KB read per session instead of rebuilding every event object.
 */
export async function refreshSession(db, handle, options = {}) {
    const { adapter, candidate } = handle;
    const id = canonicalId(adapter.provider, candidate.id);
    const aux = await adapter.auxFingerprint?.(candidate);
    const fingerprint = fingerprintOf(candidate, aux);
    const row = sessionRow(db, id);
    const l1Valid = !!row &&
        !options.force &&
        row.parser_version === PARSER_VERSION &&
        row.source_path === candidate.path &&
        row.source_size === fingerprint.sourceSize &&
        row.source_mtime_ms === fingerprint.sourceMtimeMs &&
        row.head_hash === fingerprint.headHash &&
        (row.aux_fingerprint ?? undefined) === fingerprint.auxFingerprint;
    if (!l1Valid) {
        const session = await adapter.parse(candidate);
        writeSession(db, session, fingerprint, summarizeTurns(session).length);
        deriveFacts(db, id, session);
        if (options.edges !== false)
            deriveEdges(db, id, session);
        return { id, action: 'indexed', session };
    }
    // Nothing to redo: the caller gets an id and no object was ever built.
    if (row.extractor_version === EXTRACTOR_VERSION &&
        (options.edges === false || row.edge_version === EDGE_VERSION)) {
        return { id, action: 'reused' };
    }
    const session = readSession(db, row);
    let action = 'reused';
    if (row.extractor_version !== EXTRACTOR_VERSION) {
        deriveFacts(db, id, session);
        action = 'facts-rederived';
    }
    if (options.edges !== false && row.edge_version !== EDGE_VERSION) {
        deriveEdges(db, id, session);
        action = action === 'reused' ? 'edges-rederived' : action;
    }
    return { id, action, session };
}
