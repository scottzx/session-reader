import { readTurnDirectory, readTurns, readEvents, readOriginalRecords, readCall, readArtifact } from '../reader.js';
import { callsIn } from '../calls.js';
import { buildOverview, displayPath, fileLedger, listRecentSessions, loadSession, searchSessions, summarizeTurns, } from '../index.js';
export function resolveListWorkspace(scope, workspace, fallbackCwd) {
    if (scope === 'global')
        return undefined;
    if (workspace)
        return workspace;
    if (scope && scope !== 'cwd')
        return scope;
    return fallbackCwd;
}
/** Chat-preview turns. Built only after the user clicks a session. */
export function previewTurns(normalized) {
    return summarizeTurns(normalized).map((ts) => {
        const evs = (normalized.turns || []).slice(ts.events[0], ts.events[1] + 1);
        const assistantEvents = evs.filter((e) => e.kind === 'assistant');
        const messages = evs.filter((e) => e.kind === 'user' || e.kind === 'assistant');
        const userPrompt = messages.filter((e) => e.kind === 'user').map((e) => e.fullText ?? e.text).filter(Boolean).join('\n\n');
        const toolCalls = callsIn(evs);
        return {
            no: ts.no,
            turn: ts.no,
            status: ts.status,
            prompt: ts.prompt,
            userPrompt,
            messages,
            outcome: ts.outcome,
            assistantReply: assistantEvents.map((a) => a.fullText ?? a.text).filter(Boolean).join('\n\n') || ts.outcome,
            thinking: '',
            thinkingBlocks: [],
            toolCalls,
            files: ts.files,
            commands: ts.commands,
            errors: ts.errors,
            startedAt: ts.startedAt,
            endedAt: ts.endedAt,
            durationMs: ts.durationMs,
        };
    });
}
function sessionDetailsOf(normalized) {
    const workspace = normalized.ref.workspace;
    return {
        ref: normalized.ref,
        stats: normalized.stats,
        overview: buildOverview(normalized),
        files: fileLedger(normalized).map((record) => ({
            ...record,
            displayPath: displayPath(record, workspace),
        })),
    };
}
export async function sessionPreview(sessionId) {
    const normalized = await loadSession(sessionId, { useIndex: true });
    return { ...sessionDetailsOf(normalized), turns: previewTurns(normalized) };
}
export async function listSessionsForUi(options) {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error('limit must be a positive integer');
    if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('offset must be a non-negative integer');
    const sessions = await listRecentSessions({
        limit: offset + limit,
        provider: options.provider,
        since: options.since,
        workspace: options.workspace,
        useIndex: false,
        scan: Infinity,
    });
    return sessions.slice(offset);
}
function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(payload);
}
/**
 * Shared JSON API used by the DSH plugin and `1session web`.
 * Path is already stripped of `/api/session-reader`. Returns false if unmatched.
 */
export async function handleSessionApi(pathname, url, res, options) {
    if (pathname === '/sessions' || pathname === '' || pathname === '/') {
        const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
            sendJson(res, 400, { error: 'limit must be positive; offset must be non-negative integers' });
            return true;
        }
        const scope = url.searchParams.get('scope');
        const provider = url.searchParams.get('provider') || undefined;
        const since = url.searchParams.get('since') ?? undefined;
        const workspace = resolveListWorkspace(scope, url.searchParams.get('workspace'), options.fallbackCwd);
        const sessions = await listSessionsForUi({ limit: limit + 1, offset, provider, since, workspace });
        sendJson(res, 200, { sessions: sessions.slice(0, limit), hasMore: sessions.length > limit,
            ...(sessions.length > limit ? { nextOffset: offset + limit } : {}) });
        return true;
    }
    if (pathname === '/search') {
        const query = url.searchParams.get('q') ?? '';
        const scope = url.searchParams.get('scope');
        const since = url.searchParams.get('since') ?? undefined;
        const provider = url.searchParams.get('provider') ?? undefined;
        const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 20;
        const workspace = resolveListWorkspace(scope, url.searchParams.get('workspace'), options.fallbackCwd);
        const hits = await searchSessions(query, { workspace, since, provider, limit,
            area: url.searchParams.get('area') || undefined, sessionId: url.searchParams.get('session') ?? undefined,
            terms: url.searchParams.getAll('term').length ? url.searchParams.getAll('term') : undefined,
            operator: url.searchParams.get('operator') || undefined, sort: url.searchParams.get('sort') || undefined,
            cursor: url.searchParams.get('cursor') ?? undefined, });
        sendJson(res, 200, { hits });
        return true;
    }
    const matchDirectory = pathname.match(/^\/session\/([^/]+)\/directory$/);
    if (matchDirectory) {
        sendJson(res, 200, await readTurnDirectory(decodeURIComponent(matchDirectory[1])));
        return true;
    }
    const matchDetails = pathname.match(/^\/session\/([^/]+)\/details$/);
    if (matchDetails) {
        const normalized = await loadSession(decodeURIComponent(matchDetails[1]), { useIndex: true });
        sendJson(res, 200, sessionDetailsOf(normalized));
        return true;
    }
    const matchContent = pathname.match(/^\/session\/([^/]+)\/content$/);
    if (matchContent) {
        const id = decodeURIComponent(matchContent[1]);
        const params = url.searchParams;
        const opts = { cursor: params.get('cursor') ?? undefined, maxChars: params.has('maxChars') ? Number(params.get('maxChars')) : undefined };
        if (params.get('raw') === 'true' && !params.has('event'))
            throw new Error('raw requires event');
        const body = params.has('call') ? await readCall(id, params.get('call'), opts)
            : params.has('artifact') ? await readArtifact(id, params.get('artifact'), opts)
                : params.has('event') ? await (params.get('raw') === 'true' ? readOriginalRecords : readEvents)(id, params.getAll('event'), opts)
                    : await readTurns(id, params.get('turns') ?? '1', opts);
        sendJson(res, 200, body);
        return true;
    }
    const matchSession = pathname.match(/^\/session\/([^/]+)$/);
    if (matchSession) {
        const sessionId = decodeURIComponent(matchSession[1]);
        try {
            sendJson(res, 200, await sessionPreview(sessionId));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/session not found/i.test(msg)) {
                sendJson(res, 404, { error: `Session not found: ${sessionId}` });
                return true;
            }
            throw err;
        }
        return true;
    }
    return false;
}
