import { readTurns, readEvents, readOriginalRecords, readCall, readArtifact } from '../reader.js';
import { callsIn } from '../calls.js';
import type { ServerResponse } from 'node:http';
import {
  buildOverview,
  displayPath,
  fileLedger,
  listRecentSessions,
  loadSession,
  searchSessions,
  summarizeTurns,
} from '../index.js';
import type { AgentProvider, NormalizedSession } from '../types.js';

export interface SessionApiOptions {
  /** Used when the client asks for scope=cwd but does not send ?workspace=. */
  fallbackCwd: string;
}

export function resolveListWorkspace(
  scope: string | null,
  workspace: string | null,
  fallbackCwd: string,
): string | undefined {
  if (scope === 'global') return undefined;
  if (workspace) return workspace;
  if (scope && scope !== 'cwd') return scope;
  return fallbackCwd;
}

/** Chat-preview turns. Built only after the user clicks a session. */
export function previewTurns(normalized: NormalizedSession) {
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

export async function sessionPreview(sessionId: string) {
  const normalized = await loadSession(sessionId, { useIndex: true });
  const workspace = normalized.ref.workspace;
  return {
    ref: normalized.ref,
    stats: normalized.stats,
    overview: buildOverview(normalized),
    turns: previewTurns(normalized),
    files: fileLedger(normalized).map((record) => ({
      ...record,
      displayPath: displayPath(record, workspace),
    })),
  };
}

export async function listSessionsForUi(options: {
  limit?: number;
  provider?: string;
  since?: string;
  workspace?: string;
}) {
  const limit = options.limit ?? 50;
  return listRecentSessions({
    limit,
    provider: options.provider as AgentProvider | undefined,
    since: options.since,
    workspace: options.workspace,
    useIndex: false,
    scan: Math.min(Math.max(limit * 4, 80), 200),
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(payload);
}

/**
 * Shared JSON API used by the DSH plugin and `1session web`.
 * Path is already stripped of `/api/session-reader`. Returns false if unmatched.
 */
export async function handleSessionApi(
  pathname: string,
  url: URL,
  res: ServerResponse,
  options: SessionApiOptions,
): Promise<boolean> {
  if (pathname === '/sessions' || pathname === '' || pathname === '/') {
    const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
    const scope = url.searchParams.get('scope');
    const provider = url.searchParams.get('provider') || undefined;
    const since = url.searchParams.get('since') ?? undefined;
    const workspace = resolveListWorkspace(
      scope,
      url.searchParams.get('workspace'),
      options.fallbackCwd,
    );
    const sessions = await listSessionsForUi({ limit, provider, since, workspace });
    sendJson(res, 200, { sessions });
    return true;
  }

  if (pathname === '/search') {
    const query = url.searchParams.get('q') ?? '';
    const scope = url.searchParams.get('scope');
    const since = url.searchParams.get('since') ?? undefined;
    const provider = (url.searchParams.get('provider') as AgentProvider | undefined) ?? undefined;
    const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 20;
    const workspace = resolveListWorkspace(
      scope,
      url.searchParams.get('workspace'),
      options.fallbackCwd,
    );
    const hits = await searchSessions(query, { workspace, since, provider, limit,
      area: url.searchParams.get('area') as never || undefined, sessionId: url.searchParams.get('session') ?? undefined,
      terms: url.searchParams.getAll('term').length ? url.searchParams.getAll('term') : undefined,
      operator: url.searchParams.get('operator') as never || undefined, sort: url.searchParams.get('sort') as never || undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    sendJson(res, 200, { hits });
    return true;
  }

  const matchContent = pathname.match(/^\/session\/([^/]+)\/content$/);
  if (matchContent) {
    const id = decodeURIComponent(matchContent[1]!);
    const params = url.searchParams;
    const opts = { cursor: params.get('cursor') ?? undefined, maxChars: params.has('maxChars') ? Number(params.get('maxChars')) : undefined };
    if (params.get('raw') === 'true' && !params.has('event')) throw new Error('raw requires event');
    const body = params.has('call') ? await readCall(id, params.get('call')!, opts)
      : params.has('artifact') ? await readArtifact(id, params.get('artifact')!, opts)
      : params.has('event') ? await (params.get('raw') === 'true' ? readOriginalRecords : readEvents)(id, params.getAll('event'), opts)
      : await readTurns(id, params.get('turns') ?? '1', opts);
    sendJson(res, 200, body);
    return true;
  }

  const matchSession = pathname.match(/^\/session\/([^/]+)$/);
  if (matchSession) {
    const sessionId = decodeURIComponent(matchSession[1]!);
    try {
      sendJson(res, 200, await sessionPreview(sessionId));
    } catch (err: unknown) {
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
