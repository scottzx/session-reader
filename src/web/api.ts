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
    const thinkingEvents = evs.filter((e) => e.kind === 'thinking');
    const assistantEvents = evs.filter((e) => e.kind === 'assistant');

    const toolCalls: any[] = [];
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]!;
      if (e.kind === 'tool_call') {
        const result = evs.slice(i + 1).find(
          (r) => r.kind === 'tool_result' && (r.toolName === e.toolName || !r.toolName),
        );
        toolCalls.push({
          id: e.id,
          toolName: e.toolName,
          args: e.toolArgs,
          result: result?.toolResult,
          exitCode: result?.exitCode,
          isError: result?.isError,
        });
      }
    }

    return {
      no: ts.no,
      turn: ts.no,
      status: ts.status,
      prompt: ts.prompt,
      userPrompt: ts.prompt,
      outcome: ts.outcome,
      assistantReply: assistantEvents.map((a) => a.text).filter(Boolean).join('\n\n') || ts.outcome,
      thinking: thinkingEvents.map((t) => t.text).filter(Boolean).join('\n\n'),
      thinkingBlocks: thinkingEvents.map((t) => t.text).filter(Boolean) as string[],
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
    const hits = await searchSessions(query, { workspace, since, provider, limit });
    sendJson(res, 200, { hits });
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
