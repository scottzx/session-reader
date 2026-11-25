import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  resolveSession,
  retrieveSessions,
  buildOverview,
  readTurnDirectory,
  readTurns,
  readOriginalRecords,
  readEvents,
  readCall,
  readArtifact,
} from '../index.js';
import { handleSessionApi } from '../web/api.js';
import { openSessionInDsh, continuationAvailability } from './open.js';
import { listColdArchive, restoreSession } from './archive.js';
import type { AgentProvider } from '../types.js';

export const name = 'session-reader';
// ACP is queried through ctx.get so history browsing remains available without it.
export const inject = ['tools', 'webServer', 'sessionController', 'workspaceRegistry'];


async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 16384) throw new Error('Request body too large');
  }
  const value = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object');
  return value as Record<string, unknown>;
}

export function apply(ctx: any) {
  // 1. Register tools if ctx.tools is present
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    // history_search — DSH core already owns session_search.
    ctx.effect(() => ctx.tools.register({
      name: 'history_search',
      description: 'Search past AI coding sessions across Claude Code, Codex, Antigravity, Grok and DSH. By default searches sessions in the current working directory / workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal query, or a natural-language question in semantic mode' },
          mode: { type: 'string', enum: ['keyword', 'semantic'], description: 'Default keyword. Semantic requires a prebuilt local dialogue index; returns coverage metadata.' },
          model: { type: 'string', enum: ['qwen3', 'embeddinggemma2'], description: 'Semantic vector space, default qwen3' },
          workspace: { type: 'string', description: 'Filter by workspace path (optional, defaults to current session workspace)' },
          scope: { type: 'string', description: 'Search scope: cwd (default, current session directory), global (all workspaces), or specific path' },
          since: { type: 'string', description: 'Time filter, e.g. 24h, 7d, 30d' },
          kind: { type: 'string', description: 'Filter by kind: user, assistant, thinking, tool_call, tool_result' },
          limit: { type: 'number', description: 'Max number of sessions to return' },
          area: { type: 'string', description: 'dialogue (default), tools, artifacts, or all' },
          sessionId: { type: 'string', description: 'Restrict search to one exact session or unique prefix' },
          archive: { type: 'string', enum: ['include', 'hot', 'cold'], description: 'DSH physical state: include (default), hot, or cold-archived' },
          terms: { type: 'array', items: { type: 'string' }, description: 'Explicit literal terms' },
          operator: { type: 'string', description: 'and (default) or or' },
          sort: { type: 'string', description: 'relevance (default) or time' },
          cursor: { type: 'string', description: 'Continue from a returned search cursor' },
        },
        required: ['query'],
      },
      output: {
        schema: { oneOf: [{ type: 'array' }, { type: 'object' }] },
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

        const retrieved = await retrieveSessions(args.query, {
          mode: args.mode, model: args.model, selfSessionId: exec?.agent?.session?.header?.id,
          workspace: targetWorkspace,
          since: args.since,
          kinds: args.kind ? [args.kind] : undefined,
          limit: args.limit,
          area: args.area, sessionId: args.sessionId, terms: args.terms, operator: args.operator, sort: args.sort, cursor: args.cursor,
          archive: args.archive,
        });
        return retrieved.retrieval.mode === 'semantic' ? retrieved : retrieved.hits;
      },
    }));

    // session_overview
    ctx.effect(() => ctx.tools.register({
      name: 'session_overview',
      description: 'Get statistics, files modified, commands executed, and end-state facts of a past session.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID or 8-char prefix' },
        },
        required: ['sessionId'],
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
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID or 8-char prefix' },
        },
        required: ['sessionId'],
      },
      output: {
        schema: { type: 'array' },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any) {
        return (await readTurnDirectory(args.sessionId)).turns;
      },
    }));

    // session_turn_detail
    ctx.effect(() => ctx.tools.register({
      name: 'session_turn_detail',
      description: 'Read full dialogue for one or several turns, exact event references, tool calls with results, or artifacts. Long content is paginated.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID or 8-char prefix' },
          turn: { type: 'number', description: 'Turn number (default 1)' },
          turns: { type: 'string', description: 'Turn selector, e.g. 1-3 or 1,4' },
          locator: { type: 'string', description: 'Exact event locator from search' },
          raw: { type: 'boolean', description: 'Read original JSONL records; requires locator or events' },
          callId: { type: 'string', description: 'Native call ID or call event locator' },
          artifactPath: { type: 'string', description: 'Exact artifact path from search' },
          cursor: { type: 'string', description: 'Continue from the returned content cursor' },
          maxChars: { type: 'number', description: 'Page character budget (default 32000)' },
          events: { type: 'string', description: 'Event selector, e.g. "11", "11-13", "11,15,22"' },
        },
        required: ['sessionId'],
      },
      output: {
        schema: { oneOf: [{ type: 'object' }, { type: 'array' }] },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any) {
        const options = { cursor: args.cursor, maxChars: args.maxChars };
        if (args.callId) return readCall(args.sessionId, args.callId, options);
        if (args.artifactPath) return readArtifact(args.sessionId, args.artifactPath, options);
        if (args.raw && !args.locator && !args.events) throw new Error('raw requires locator or events');
        if (args.locator || args.events) return (args.raw ? readOriginalRecords : readEvents)(args.sessionId, [args.locator ?? args.events], options);
        return readTurns(args.sessionId, args.turns ?? String(args.turn ?? 1), options);
      },
    }));

    // session_open_in_dsh
    ctx.effect(() => ctx.tools.register({
      name: 'session_open_in_dsh',
      description: 'Open a historical session in DSH and continue with its original Agent. External sessions require the ACP plugin; unsupported sources remain read-only.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID, prefix, or native transcript path' },
          provider: { type: 'string', description: 'Source provider to disambiguate an ID: claude, codex, grok, dsh, or antigravity' },
        },
        required: ['sessionId'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any) {
        return openSessionInDsh(ctx, { sessionId: args.sessionId, provider: args.provider });
      },
    }));

    // cold_archive_list — browse physically archived sessions without DSH's hot list.
    ctx.effect(() => ctx.tools.register({
      name: 'cold_archive_list',
      description: 'List DSH sessions physically moved to the cold archive, with their original workspace and archive metadata.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: { type: 'object' },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute() {
        const entries = await listColdArchive();
        return { count: entries.length, sessions: entries };
      },
    }));

    // cold_archive_restore — move a cold session back into DSH's hot tree.
    ctx.effect(() => ctx.tools.register({
      name: 'cold_archive_restore',
      description: 'Restore one cold-archived DSH session to its original hot directory so DSH can open it again. Refuses to overwrite an existing target.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'Cold-archived session id or unique prefix' } },
        required: ['sessionId'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any) {
        return restoreSession({ sessionId: args.sessionId });
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
            const value = await readJsonBody(req);
            if (typeof value.sessionId !== 'string' || !value.sessionId || (value.provider !== undefined && typeof value.provider !== 'string')) {
              res.statusCode = 400; res.end(JSON.stringify({ error: 'sessionId and optional provider must be strings' })); return;
            }
            res.end(JSON.stringify(await openSessionInDsh(ctx, { sessionId: value.sessionId, provider: value.provider as AgentProvider | undefined })));
            return;
          }

          if (pathname === '/cold-archive/list') {
            if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Use GET to list the cold archive' })); return; }
            const sessions = await listColdArchive();
            res.end(JSON.stringify({ count: sessions.length, sessions }));
            return;
          }
          if (pathname === '/cold-archive/restore') {
            if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Use POST to restore a session' })); return; }
            if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
              res.statusCode = 403; res.end(JSON.stringify({ error: 'Cross-origin cold archive changes are not allowed' })); return;
            }
            const value = await readJsonBody(req);
            if (typeof value.sessionId !== 'string' || !value.sessionId) { res.statusCode = 400; res.end(JSON.stringify({ error: 'sessionId must be a non-empty string' })); return; }
            res.end(JSON.stringify(await restoreSession({ sessionId: value.sessionId, dryRun: value.dryRun === true })));
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
