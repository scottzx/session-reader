import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import {
  resolveSession,
  searchSessions,
  buildOverview,
  summarizeTurns,
  turnDetail,
  eventDetails,
} from '../index.js';
import { handleSessionApi } from '../web/api.js';
import { convertSessionToDshEvents } from './adapter.js';

export const name = 'session-reader';
export const inject = ['tools', 'webServer'];

export function apply(ctx: any) {
  // 1. Register tools if ctx.tools is present
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    // session_search
    ctx.tools.register({
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
    });

    // session_overview
    ctx.tools.register({
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
    });

    // session_turns
    ctx.tools.register({
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
    });

    // session_turn_detail
    ctx.tools.register({
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
    });

    // session_open_in_dsh
    ctx.tools.register({
      name: 'session_open_in_dsh',
      description: 'Load a cross-agent historical session into DSH native sessions and automatically assign it to the DSH workspace.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Session ID to import into DSH' },
        currentCwd: { type: 'string', description: 'Optional current session working directory fallback' },
      },
      output: {
        schema: { type: 'object' },
        render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args: any, exec?: any) {
        const resolved = await resolveSession(args.sessionId);
        if (!resolved) throw new Error(`Session not found: ${args.sessionId}`);
        const normalized = await resolved.adapter.parse(resolved.candidate);
        const dshEvents = convertSessionToDshEvents(normalized);
        const rawId = normalized.ref.id;
        const sanitizedId = rawId.replace(/[^a-zA-Z0-9_-]/g, '-');
        const dshSessionId = sanitizedId.startsWith('session-') ? sanitizedId : `session-${sanitizedId}`;

        const currentSessionCwd = exec?.agent?.session?.header?.cwd ?? args.currentCwd;
        let targetCwd: string | undefined;
        if (normalized.ref.workspace && typeof normalized.ref.workspace === 'string' && normalized.ref.workspace.startsWith('/')) {
          try {
            const st = await fs.promises.stat(normalized.ref.workspace);
            if (st.isDirectory()) {
              targetCwd = await fs.promises.realpath(normalized.ref.workspace);
            }
          } catch {}
        }
        if (!targetCwd) {
          const fallback = currentSessionCwd || process.cwd();
          try {
            const st = await fs.promises.stat(fallback);
            if (st.isDirectory()) {
              targetCwd = await fs.promises.realpath(fallback);
            }
          } catch {}
        }
        if (!targetCwd) targetCwd = process.cwd();

        const createdAt = normalized.ref.createdAt ? Date.parse(normalized.ref.createdAt) : Date.now();

        const header: any = {
          version: 2,
          id: dshSessionId,
          cwd: targetCwd,
          createdAt: isNaN(createdAt) ? Date.now() : createdAt,
          isSeeded: false,
          delegationDepth: 0,
        };

        const persistence = ctx.get ? ctx.get('sessionPersistence') : ctx.sessionPersistence;
        if (persistence && typeof persistence.create === 'function') {
          try {
            const existingStat = await persistence.stat(dshSessionId);
            if (!existingStat) {
              const handle = await persistence.create(header);
              await handle.append(dshEvents);
              await handle.flush();
              await handle.close();
            }
          } catch (e: any) {
            console.warn('[session-reader] persistence notice:', e?.message || e);
          }
        }

        const sessions = ctx.get ? ctx.get('sessions') : ctx.sessions;
        if (sessions && typeof sessions.create === 'function') {
          try {
            if (!sessions.get(dshSessionId)) {
              sessions.create(dshSessionId, { seed: dshEvents, meta: header });
            }
          } catch (e: any) {
            console.warn('[session-reader] sessions.create notice:', e?.message || e);
          }
        }

        const workspaceRegistry = ctx.get ? (ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry) : ctx.workspaceRegistry;
        let attachedWorkspaceId: string | undefined;
        if (workspaceRegistry && typeof workspaceRegistry.create === 'function') {
          try {
            const ws = await workspaceRegistry.create(targetCwd);
            if (ws && typeof ws.attachSession === 'function') {
              await ws.attachSession(dshSessionId);
              attachedWorkspaceId = ws.id;
            }
          } catch (wsErr: any) {
            console.warn('[session-reader] workspace attach notice:', wsErr?.message || wsErr);
          }
        }

        return {
          success: true,
          dshSessionId,
          eventCount: dshEvents.length,
          title: normalized.ref.title,
          workspace: targetCwd,
          workspaceId: attachedWorkspaceId,
        };
      },
    });
  }

  // 2. Register HTTP routes if ctx.webServer is present
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.webServer.register({
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
          if (pathname === '/open-in-dsh') {
            let sessionId = url.searchParams.get('id');
            let currentCwd = url.searchParams.get('currentCwd') ?? undefined;
            if (!sessionId && (req.method === 'POST' || req.method === 'PUT')) {
              const body = await new Promise<any>((resolve) => {
                let data = '';
                req.on('data', chunk => data += chunk);
                req.on('end', () => {
                  try { resolve(JSON.parse(data)); } catch { resolve({}); }
                });
                req.on('error', () => resolve({}));
              });
              sessionId = body?.sessionId || body?.id;
              currentCwd = body?.currentCwd || currentCwd;
            }
            if (!sessionId) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Missing sessionId' }));
              return;
            }
            const resolved = await resolveSession(sessionId);
            if (!resolved) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
              return;
            }
            const normalized = await resolved.adapter.parse(resolved.candidate);
            const dshEvents = convertSessionToDshEvents(normalized);

            const rawId = normalized.ref.id;
            const sanitizedId = rawId.replace(/[^a-zA-Z0-9_-]/g, '-');
            const dshSessionId = sanitizedId.startsWith('session-') ? sanitizedId : `session-${sanitizedId}`;

            let targetCwd: string | undefined;
            if (normalized.ref.workspace && typeof normalized.ref.workspace === 'string' && normalized.ref.workspace.startsWith('/')) {
              try {
                const st = await fs.promises.stat(normalized.ref.workspace);
                if (st.isDirectory()) {
                  targetCwd = await fs.promises.realpath(normalized.ref.workspace);
                }
              } catch {}
            }
            if (!targetCwd) {
              const fallback = currentCwd || process.cwd();
              try {
                const st = await fs.promises.stat(fallback);
                if (st.isDirectory()) {
                  targetCwd = await fs.promises.realpath(fallback);
                }
              } catch {}
            }
            if (!targetCwd) targetCwd = process.cwd();

            const createdAt = normalized.ref.createdAt ? Date.parse(normalized.ref.createdAt) : Date.now();

            const header: any = {
              version: 2,
              id: dshSessionId,
              cwd: targetCwd,
              createdAt: isNaN(createdAt) ? Date.now() : createdAt,
              isSeeded: false,
              delegationDepth: 0,
            };

            // 1. Persistence if available
            const persistence = ctx.get ? ctx.get('sessionPersistence') : ctx.sessionPersistence;
            if (persistence && typeof persistence.create === 'function') {
              try {
                const existingStat = await persistence.stat(dshSessionId);
                if (!existingStat) {
                  const handle = await persistence.create(header);
                  await handle.append(dshEvents);
                  await handle.flush();
                  await handle.close();
                }
              } catch (persistErr: any) {
                console.warn('[session-reader] persistence notice:', persistErr?.message || persistErr);
              }
            }

            // 2. In-memory sessions if available
            const sessions = ctx.get ? ctx.get('sessions') : ctx.sessions;
            if (sessions && typeof sessions.create === 'function') {
              try {
                if (!sessions.get(dshSessionId)) {
                  sessions.create(dshSessionId, {
                    seed: dshEvents,
                    meta: header,
                  });
                }
              } catch (sessionErr: any) {
                console.warn('[session-reader] sessions.create notice:', sessionErr?.message || sessionErr);
              }
            }

            // 3. Workspace attachment if workspaceRegistry is available
            const workspaceRegistry = ctx.get ? (ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry) : ctx.workspaceRegistry;
            let attachedWorkspaceId: string | undefined;
            if (workspaceRegistry && typeof workspaceRegistry.create === 'function') {
              try {
                const ws = await workspaceRegistry.create(targetCwd);
                if (ws && typeof ws.attachSession === 'function') {
                  await ws.attachSession(dshSessionId);
                  attachedWorkspaceId = ws.id;
                }
              } catch (wsErr: any) {
                console.warn('[session-reader] workspace attach notice:', wsErr?.message || wsErr);
              }
            }

            res.statusCode = 200;
            res.end(JSON.stringify({
              success: true,
              dshSessionId,
              eventCount: dshEvents.length,
              title: normalized.ref.title,
              workspace: targetCwd,
              workspaceId: attachedWorkspaceId,
            }));
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
    });
  }
}
