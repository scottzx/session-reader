/**
 * `1session serve` — session-reader 作为 DreamMate Network 的第一个标准 Service。
 *
 * 它把本地 Read Plane 原样暴露成网络能力：`1session overview <id>` 成为
 * `sessions.read`。**不重新实现索引与事实层**，只是换一个调用入口。
 *
 * HTTP 层不引第三方框架，只用 node:http；端口与协议类型来自 L0 包。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { listRecentSessions, loadSession } from '../resolver.js';
import { buildOverview } from '../overview.js';
import { summarizeTurns } from '../turns.js';
import { searchSessions } from '../search.js';
import { canonicalizePath } from '../util/paths.js';
import type { AgentProvider, TurnKind } from '../types.js';
import { buildManifest, nodeIdentity, sessionUri } from './node.js';
import { DEFAULT_PORTS, type Reachability } from '@1agents/dreammate-network';
import { reportAndHoldRegistration } from '@1agents/dreammate-node/client';
import { SESSION_CAPABILITIES } from './node.js';

/** 约定端口，由 L0 协议包定义——Control Plane 的 pull 探测照着它找服务。 */
export const DEFAULT_PORT = DEFAULT_PORTS['session-registry'];

export interface ServeOptions {
  /** 默认 {@link DEFAULT_PORT}。换端口就探测不到了，得自己 register。 */
  port?: number;
  /**
   * Defaults to loopback. Session transcripts contain source code, shell
   * history and whatever secrets happened to scroll past, so going beyond this
   * machine has to be a deliberate act — pass the tailnet address explicitly.
   */
  host?: string;
  /** When set, every request must carry it as `Authorization: Bearer <token>`. */
  token?: string;
  /** Advertised base url, when behind a proxy or a different tailnet name. */
  baseUrl?: string;
  /**
   * 向本机 node agent 报备自己。默认开——agent 没起时是静默 no-op，没有代价。
   * 报备后外部探一个 36908 就能看见本服务，不必碰运气猜端口。
   */
  report?: boolean;
}

interface Ctx {
  url: URL;
  /** `X-Caller-Session`: who is doing the reading, so the edge can be recorded. */
  caller?: string;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const q = (ctx: Ctx, name: string): string | undefined => ctx.url.searchParams.get(name) ?? undefined;
const qn = (ctx: Ctx, name: string): number | undefined => {
  const raw = q(ctx, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * `?scope=` is a path whose subtree is included; omitting it means the whole
 * machine. The CLI defaults to the cwd instead, which is meaningless for a
 * long-running server.
 */
const scopeOf = (ctx: Ctx): string | undefined => {
  const scope = q(ctx, 'scope');
  return scope && scope !== 'global' ? canonicalizePath(scope) : undefined;
};

/** Records `caller --references--> target` while the read is happening. */
async function noteRead(verb: string, target: string, caller?: string): Promise<void> {
  if (!caller) return;
  try {
    const { openStore } = await import('../store/db.js');
    const { captureRuntimeEdge } = await import('../store/edges.js');
    captureRuntimeEdge(await openStore(), verb, target, caller);
  } catch {
    // An edge is a nice-to-have; never fail the read over it.
  }
}

async function route(ctx: Ctx): Promise<{ status: number; body: unknown }> {
  const { pathname } = ctx.url;
  const identity = await nodeIdentity();

  if (pathname === '/health') {
    return { status: 200, body: { status: 'ok', node_id: identity.node_id, service: 'session-registry' } };
  }

  // `/manifest` is the network-wide contract; `/v1/node` is the same document
  // under this service's own prefix.
  if (pathname === '/manifest' || pathname === '/v1/node') {
    return { status: 200, body: await buildManifest(ctx.url.origin) };
  }

  if (pathname === '/v1/sessions') {
    const refs = await listRecentSessions({
      limit: qn(ctx, 'limit') ?? 20,
      workspace: scopeOf(ctx),
      since: q(ctx, 'since'),
      provider: q(ctx, 'provider') as AgentProvider | undefined,
      useIndex: true,
    });
    return {
      status: 200,
      body: {
        node: identity.name,
        sessions: refs.map((ref) => ({ ...ref, uri: sessionUri(identity.name, ref.provider, ref.id) })),
      },
    };
  }

  const detail = /^\/v1\/sessions\/([^/]+)(\/turns)?$/.exec(pathname);
  if (detail) {
    const id = decodeURIComponent(detail[1]!);
    const wantTurns = detail[2] !== undefined;
    const session = await loadSession(id, { useIndex: true });
    await noteRead(wantTurns ? 'turns' : 'overview', id, ctx.caller);
    const uri = sessionUri(identity.name, session.ref.provider, session.ref.id);
    return wantTurns
      ? { status: 200, body: { uri, turns: summarizeTurns(session) } }
      : { status: 200, body: { uri, ...buildOverview(session) } };
  }

  if (pathname === '/v1/search') {
    const query = q(ctx, 'q') ?? q(ctx, 'query');
    if (!query) return { status: 400, body: { error: 'missing ?q=' } };
    const hits = await searchSessions(query, {
      workspace: scopeOf(ctx),
      since: q(ctx, 'since'),
      limit: qn(ctx, 'limit'),
      provider: q(ctx, 'provider') as AgentProvider | undefined,
      kinds: q(ctx, 'kind')?.split(',').map((k) => k.trim()).filter(Boolean) as TurnKind[] | undefined,
      regex: q(ctx, 'regex') === 'true',
      caseSensitive: q(ctx, 'case') === 'true',
      context: qn(ctx, 'context'),
      maxPerSession: qn(ctx, 'max-hits'),
      useIndex: true,
    });
    return {
      status: 200,
      body: {
        query,
        total: hits.reduce((sum, hit) => sum + hit.totalMatches, 0),
        hits: hits.map((hit) => ({
          ...hit,
          uri: sessionUri(identity.name, hit.session.provider, hit.session.id),
        })),
      },
    };
  }

  const graph = /^\/v1\/graph\/([^/]+)$/.exec(pathname);
  if (graph) {
    const id = decodeURIComponent(graph[1]!);
    const { openStore } = await import('../store/db.js');
    const { edgeEvidence, edgesOf } = await import('../store/edges.js');
    const { findSessionRow } = await import('../store/read.js');
    await loadSession(id, { useIndex: true }); // make sure it is indexed first
    await noteRead('graph', id, ctx.caller);
    const db = await openStore();
    const row = findSessionRow(db, id);
    if (!row) return { status: 404, body: { error: `session not found: ${id}` } };
    const edges = edgesOf(db, row.id).map((edge) => ({
      ...edge,
      evidence: edgeEvidence(db, edge.from, edge.to, edge.relation),
    }));
    return { status: 200, body: { session: row.id, edges } };
  }

  return { status: 404, body: { error: `no route: ${pathname}` } };
}

export function createServer(options: ServeOptions = {}): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return json(res, 405, { error: 'read-only service: GET only' });
        }
        const url = new URL(req.url ?? '/', options.baseUrl ?? `http://${req.headers.host ?? 'localhost'}`);
        if (options.token) {
          const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
          if (bearer !== options.token) return json(res, 401, { error: 'unauthorized' });
        }
        const caller = req.headers['x-caller-session'];
        const { status, body } = await route({
          url,
          caller: typeof caller === 'string' ? caller : undefined,
        });
        json(res, status, body);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // A bad session id reads as "not found", not as a server fault.
        json(res, /not found|missing|no session/i.test(message) ? 404 : 500, { error: message });
      }
    })();
  });
}

export async function serve(options: ServeOptions = {}): Promise<http.Server> {
  const host = options.host ?? '127.0.0.1';
  const server = createServer(options);
  await new Promise<void>((resolve) => server.listen(options.port ?? DEFAULT_PORT, host, resolve));
  const { port } = server.address() as AddressInfo;
  const identity = await nodeIdentity();

  // 只听回环的服务，外部发现得了却连不上——如实说，别让调用方白跑一趟。
  const reachability: Reachability =
    host === '127.0.0.1' || host === 'localhost' || host === '::1' ? 'localhost' : 'network';
  const reported =
    options.report === false
      ? undefined
      : await reportAndHoldRegistration({
          id: 'session-registry',
          name: 'session-reader',
          kind: 'session_registry',
          capabilities: [...SESSION_CAPABILITIES],
          port,
          reachability,
          resources: [{ scheme: 'session' }],
        });
  console.log(`1session serve — node ${identity.name} (${identity.node_id})`);
  console.log(`  http://${host}:${port}/manifest`);
  console.log(`  capabilities: sessions.list, sessions.read, sessions.turns, sessions.search, sessions.graph`);
  if (reported) {
    console.log(
      reported.ok
        ? `  已向本机 node agent 报备（reachability=${reachability}）`
        : `  未报备：${reported.reason}——不影响本服务，只是外部得靠约定端口找它`,
    );
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && !options.token) {
    console.warn(
      `  ⚠️  绑定在 ${host} 且未设置 --token：会话原文（代码、shell 历史、密钥）将对该网络开放。`,
    );
  }
  return server;
}
