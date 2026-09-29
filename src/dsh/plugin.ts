import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  resolveSession,
  searchSessions,
  buildOverview,
  summarizeTurns,
  turnDetail,
  eventDetails,
} from '../index.js';
import { handleSessionApi } from '../web/api.js';
import { openSessionInDsh, continuationAvailability } from './open.js';
import type { AgentProvider } from '../types.js';

export const name = 'session-reader';
// ACP is queried through ctx.get so history browsing remains available without it.
export const inject = ['tools', 'webServer', 'sessionController', 'workspaceRegistry'];

export function apply(ctx: any) {
  // 1. Register tools if ctx.tools is present
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    // session_search
    ctx.effect(() => ctx.tools.register({
      name: 'session_search',
      description: 'Search past AI coding sessions across Claude Code, Codex, Antigravity, Grok and DSH. By default searches sessions in the current working directory / workspace.',
      parameters: {
        query: { type: 'string', required: true, description: 'Keywords, file paths, or error messages to search for' },
        workspace: { type: 'string', description: 'Filter by workspace path (optional, defaults to current session workspace)' },
        scope: { type: 'string', description: 'Search scope: cwd (default, current session directory), global (all workspaces), or specific path' },
        since: { type: 'string', description: 'Time filter, e.g. 24h, 7d, 30d' },
        kind: { type: 'string', description: 'Filter by kind: user, assistant, thinking, tool_call, tool_result' },
        limit: { type: 'number', description: 'Max number of sessions to return' },
      },
      output: {
        schema: { type: 'array' },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any, exec?: any) {
        const currentCwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
        let targetWorkspace: string | undefined;
        if (args.scope === 'global') {
          targetWorkspace = undefined;
        } else if (args.workspace) {
          targetWorkspace = args.workspace;
        } else if (args.scope && args.scope !== 'cwd') {
          targetWorkspace = args.scope;
        } else {
          // Default to current session PWD
          targetWorkspace = currentCwd;
        }

        const hits = await searchSessions(args.query, {
          workspace: targetWorkspace,
          since: args.since,
          kinds: args.kind ? [args.kind] : undefined,
          limit: args.limit,
        });
        return hits.map((h: any) => ({
          sessionId: h.session.id,
          provider: h.session.provider,
          workspace: h.session.workspace,
          title: h.session.title,
          updatedAt: h.session.updatedAt,
          matchCount: h.matches.length,
          matches: h.matches.slice(0, 5).map((m: any) => ({
            turn: m.turn,
            kind: m.kind,
            excerpt: m.excerpt,
          })),
        }));
      },
    }));

    // session_overview
    ctx.effect(() => ctx.tools.register({
      name: 'session_overview',
      description: 'Get statistics, files modified, commands executed, and end-state facts of a past session.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Session ID or 8-char prefix' },
      },
      output: {
        schema: { type: 'object' },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any) {
        const resolved = await resolveSession(args.sessionId);
        if (!resolved) throw new Error(`Session not found: ${args.sessionId}`);
        const normalized = await resolved.adapter.parse(resolved.candidate);
        const overview = buildOverview(normalized);
        return {
          id: normalized.ref.id,
          provider: normalized.ref.provider,
          title: normalized.ref.title,
          workspace: normalized.ref.workspace,
          markdown: overview.markdown,
          stats: overview.stats,
        };
      },
    }));

    // session_turns
    ctx.effect(() => ctx.tools.register({
      name: 'session_turns',
      description: 'Get turn-by-turn summary of what was discussed and done in a session.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Session ID or 8-char prefix' },
      },
      output: {
        schema: { type: 'array' },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any) {
        const resolved = await resolveSession(args.sessionId);
        if (!resolved) throw new Error(`Session not found: ${args.sessionId}`);
        const normalized = await resolved.adapter.parse(resolved.candidate);
        return summarizeTurns(normalized);
      },
    }));

    // session_turn_detail
    ctx.effect(() => ctx.tools.register({
      name: 'session_turn_detail',
      description: 'Inspect full untruncated events, tool calls, and results for a specific turn in a session.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Session ID or 8-char prefix' },
        turn: { type: 'number', required: true, description: 'Turn number' },
        events: { type: 'string', description: 'Event selector, e.g. "11", "11-13", "11,15,22"' },
      },
      output: {
        schema: { oneOf: [{ type: 'object' }, { type: 'array' }] },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any) {
        const resolved = await resolveSession(args.sessionId);
        if (!resolved) throw new Error(`Session not found: ${args.sessionId}`);
        const normalized = await resolved.adapter.parse(resolved.candidate);
        if (args.events) {
          return await eventDetails(normalized, args.events);
        }
        return turnDetail(normalized, args.turn);
      },
    }));

    // session_open_in_dsh
    ctx.effect(() => ctx.tools.register({
      name: 'session_open_in_dsh',
      description: 'Open a historical session in DSH and continue with its original Agent. External sessions require the ACP plugin; unsupported sources remain read-only.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Session ID, prefix, or native transcript path' },
        provider: { type: 'string', description: 'Source provider to disambiguate an ID: claude, codex, grok, dsh, or antigravity' },
      },
      output: {
        schema: { type: 'object' },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any) {
        return openSessionInDsh(ctx, { sessionId: args.sessionId, provider: args.provider });
      },
    }));
  }

  // 2. Register HTTP routes if ctx.webServer is present
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/session-reader',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const pathname = url.pathname.replace(/^\/api\/session-reader/, '');

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        try {
          if (pathname === '/continuation') {
            const provider = url.searchParams.get('provider') as AgentProvider | null;
            if (!provider) throw new Error('Missing provider');
            res.end(JSON.stringify(await continuationAvailability(ctx, { provider })));
            return;
          }
          if (pathname === '/open-in-dsh') {
            if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Use POST to open a session' })); return; }
            if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
              res.statusCode = 403; res.end(JSON.stringify({ error: 'Cross-origin session imports are not allowed' })); return;
            }
            let body = '';
            for await (const chunk of req) { body += String(chunk); if (body.length > 16384) throw new Error('Request body too large'); }
            const value = JSON.parse(body);
            if (typeof value.sessionId !== 'string' || !value.sessionId || (value.provider !== undefined && typeof value.provider !== 'string')) {
              res.statusCode = 400; res.end(JSON.stringify({ error: 'sessionId and optional provider must be strings' })); return;
            }
            res.end(JSON.stringify(await openSessionInDsh(ctx, { sessionId: value.sessionId, provider: value.provider })));
            return;
          }

          const handled = await handleSessionApi(pathname, url, res, { fallbackCwd: process.cwd() });
          if (handled) return;

          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Endpoint not found' }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err?.message ?? String(err) }));
        }
      },
    }));
  }
}
