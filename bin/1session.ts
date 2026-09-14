#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { aggregateWorkspaceSessions } from '../src/aggregator.js';
import { distillSession } from '../src/distiller.js';
import { buildOverview } from '../src/overview.js';
import { eventDetail, summarizeTurns, turnDetail } from '../src/turns.js';
import { commandLedger, displayPath, errorLedger, fileLedger, jobLedger } from '../src/ledger.js';
import { listRecentSessions, loadSession } from '../src/resolver.js';
import { searchSessions } from '../src/search.js';
import { canonicalizePath } from '../src/util/paths.js';
import { oneLine } from '../src/util/text.js';
import type { DigestFocus, FileGroup, NormalizedSession, TurnKind } from '../src/types.js';

const USAGE = `1session — cross-agent session Read Plane

  1session list [--limit <n>] [--scope <path>|cwd|global] [--provider <name>] [--since 24h] [--json]
  1session overview <session-id> [--json]              第 1 层：会话概要
  1session turns <session-id> [--json]                 第 2 层：逐轮概要
  1session turn <session-id> <n> [--event <k>] [--json] 第 3 层：单轮 / 单次工具调用明细
  1session jobs <session-id> [--json]                  异步作业账本
  1session commands <session-id> [--failed] [--host h] [--turn n] [--json]
  1session files <session-id> [--group project|runtime|log|all] [--json]
  1session errors <session-id> [--json]
  1session digest <session-id> [--focus marketing|review|full] [--json]
  1session workspace [path] [--since 24h] [--limit <n>] [--digest] [--focus <f>] [--json]
  1session index [<session-id>] [--all] [--scope <path>|cwd|global] [--force] [--since 30d]  建立/刷新索引
  1session graph <session-id> [--json]                 会话之间的引用关系
  1session serve [--port 7777] [--host 127.0.0.1] [--token <t>] [--no-report]
                          起 HTTP Service，把本机会话接入 DreamMate Network
  1session skill install|status|uninstall [--agent claude,codex,antigravity]
                          [--copy] [--force] [--dry-run] [--json]  装到三家智能体的 skills 目录
  1session search <query> [--scope <path>|cwd|global] [--since 24h] [--limit n] [--provider name]
                          [--kind user,assistant,thinking,tool_call,tool_result]
                          [--regex] [--case] [--context n] [--max-hits n] [--json]

全局：--no-index 绕过索引直读源文件。索引位于 ~/.1agents/session-reader/index.db
     list / search / index --all 默认只看当前 pwd 目录（含子目录）下的会话。
     --scope 取当前目录的相对路径或绝对路径，按子树匹配：--scope .. 含同级项目，
     --scope ~ 含 home 下全部；--global（= --scope global，= --scope /）跨全部项目。

Providers: antigravity (~/.gemini/antigravity/brain), claude (~/.claude/projects), codex (~/.codex/sessions).
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that never take a value, so they cannot swallow a positional. */
const BOOLEAN_FLAGS = new Set([
  'json', 'failed', 'digest', 'regex', 'case', 'all', 'force', 'no-index', 'global',
  'copy', 'dry-run', 'no-report',
]);

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '-n') {
      flags.n = rest[++i] ?? '';
    } else if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = rest[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}


const TURN_MARK: Record<string, string> = {
  completed: '✓',
  unfinished: '⚠',
  nudged: '↻',
  interrupted: '✂',
  no_response: '⊘',
  failed_tail: '✗',
};

const str = (value: string | boolean | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;
const num = (value: string | boolean | undefined): number | undefined => {
  const text = typeof value === 'string' ? value : undefined;
  if (text === undefined) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const kindsOf = (value: string | boolean | undefined): TurnKind[] | undefined =>
  str(value)
    ?.split(',')
    .map((kind) => kind.trim())
    .filter(Boolean) as TurnKind[] | undefined;
const focusOf = (value: string | boolean | undefined): DigestFocus => {
  const focus = str(value);
  return focus === 'marketing' || focus === 'full' ? focus : 'review';
};

/**
 * Which folder a listing covers. `cwd` (the default) is the current working
 * directory, `global` is everything, and anything else is read as a path —
 * relative to the cwd or absolute — whose whole subtree is included, so
 * `--scope ..` covers the sibling projects too and `--scope /` is `global`.
 * `--workspace <path>` is the older spelling of the path form and wins.
 */
function scopeWorkspace(flags: Record<string, string | boolean>): string | undefined {
  const scope = str(flags.workspace) ?? str(flags.scope) ?? (flags.global === true ? 'global' : 'cwd');
  if (scope === 'global') return undefined;
  const target = canonicalizePath(scope === 'cwd' ? process.cwd() : scope);
  // A mistyped path would otherwise read as an honest "no sessions found".
  if (!existsSync(target)) throw new Error(`--scope 目录不存在：${scope}`);
  return target;
}

function print(json: boolean, data: unknown, text: string): void {
  console.log(json ? JSON.stringify(data, null, 2) : text);
}

let useIndex = true;

async function load(sessionId: string | undefined): Promise<NormalizedSession> {
  if (!sessionId) throw new Error('missing <session-id>');
  return loadSession(sessionId, { useIndex });
}

/**
 * Records "this session read that one" while it is happening, when the caller
 * identity was injected. Costs nothing and is silently skipped otherwise.
 */
async function noteRead(verb: string, target: string | undefined): Promise<void> {
  if (!useIndex || !target || !process.env.SESSION_READER_CALLER_SESSION) return;
  const { openStore } = await import('../src/store/db.js');
  const { captureRuntimeEdge } = await import('../src/store/edges.js');
  captureRuntimeEdge(await openStore(), verb, target);
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === true;
  useIndex = flags['no-index'] !== true;
  await noteRead(command, positional[0]);

  switch (command) {
    case 'list': {
      const refs = await listRecentSessions({
        limit: num(flags.limit) ?? 20,
        workspace: scopeWorkspace(flags),
        since: str(flags.since),
        provider: str(flags.provider) as never,
        useIndex,
      });
      print(
        json,
        refs,
        refs
          .map(
            (ref) =>
              `${ref.provider.padEnd(11)} ${ref.id.slice(0, 8)}  ${ref.updatedAt ?? '?'}  ` +
              `${ref.workspace ? path.basename(ref.workspace) : '-'}  ${oneLine(ref.title, 70)}`,
          )
          .join('\n') || '(no sessions found)',
      );
      break;
    }

    case 'overview': {
      const session = await load(positional[0]);
      const overview = buildOverview(session);
      print(json, overview, overview.markdown);
      break;
    }

    case 'jobs': {
      const session = await load(positional[0]);
      const jobs = jobLedger(session);
      print(
        json,
        jobs,
        jobs.length
          ? jobs
              .map(
                (job) =>
                  `[${job.status}] ${job.log ?? job.id}${job.pid ? ` pid ${job.pid}` : ''}` +
                  `${job.host ? ` @${job.host}` : ''}` +
                  `${job.startedAt ? `  ${job.startedAt.slice(0, 19)}` : ''}` +
                  `  [${job.provenance} · ${job.extractor}]` +
                  `\n    ${job.evidence.join('；')}` +
                  `${job.command ? `\n    ${oneLine(job.command, 150)}` : ''}`,
              )
              .join('\n')
          : '（该会话没有发现后台作业）',
      );
      break;
    }

    case 'commands': {
      const session = await load(positional[0]);
      const host = str(flags.host);
      const turn = num(flags.turn);
      const records = commandLedger(session).filter(
        (record) =>
          (flags.failed !== true || (record.exitCode ?? 0) !== 0) &&
          (host === undefined || record.host === host) &&
          (turn === undefined || record.turn === turn),
      );
      print(
        json,
        records,
        [
          `${records.length} 条命令（来源：${[...new Set(records.map((r) => `${r.provenance}/${r.extractor}`))].join('  ') || '-'}）`,
          '',
          ...records.map(
            (record) =>
              `T${String(record.turn).padStart(2, ' ')} #${String(record.eventIndex).padStart(4, ' ')} ` +
              `exit ${String(record.exitCode ?? '?').padStart(3, ' ')}` +
              `${record.durationMs ? ` ${(record.durationMs / 1000).toFixed(1)}s` : ''}` +
              `${record.host ? ` @${record.host}` : ''}  ${oneLine(record.command, 130)}`,
          ),
        ].join('\n'),
      );
      break;
    }

    case 'files': {
      const session = await load(positional[0]);
      const wanted = str(flags.group) as FileGroup | 'all' | undefined;
      const records = fileLedger(session).filter((record) =>
        // `all` means all; only the default view hides logs.
        wanted === 'all' ? true : wanted === undefined ? record.group !== 'log' : record.group === wanted,
      );
      print(
        json,
        records,
        [
          `${records.length} 个文件${wanted ? `（group=${wanted}）` : '（默认不含 log，用 --group all 看全部）'}`,
          '',
          ...records.map(
            (record) =>
              `[${record.group}] ${record.provenance.padEnd(9)} T${record.turn} ` +
              `${displayPath(record, session.ref.workspace)}　\`${record.extractor}${record.eventIndex >= 0 ? ` E${record.eventIndex}` : ''}\``,
          ),
        ].join('\n'),
      );
      break;
    }

    case 'errors': {
      const session = await load(positional[0]);
      const records = errorLedger(session);
      print(
        json,
        records,
        [
          `${records.length} 条失败命令`,
          '',
          ...records.map(
            (record) =>
              `T${record.turn} #${record.eventIndex} exit ${record.exitCode ?? '?'}` +
              `${record.laterSucceeded ? '  → 同前缀命令后续成功过' : ''}` +
              `\n    ${oneLine(record.command, 150)}` +
              `${record.stderr ? `\n    ${oneLine(record.stderr, 150)}` : ''}`,
          ),
        ].join('\n'),
      );
      break;
    }

    case 'digest': {
      const session = await load(positional[0]);
      const digest = distillSession(session, { focus: focusOf(flags.focus) });
      print(json, digest, digest.markdown);
      break;
    }

    case 'workspace': {
      const target = canonicalizePath(positional[0] ?? '.');
      if (flags.digest === true || flags.focus) {
        const digest = await aggregateWorkspaceSessions(target, {
          since: str(flags.since),
          limit: num(flags.limit),
          focus: focusOf(flags.focus),
        });
        print(json, digest, digest.markdown);
        break;
      }
      const refs = await listRecentSessions({
        workspace: target,
        since: str(flags.since),
        limit: num(flags.limit) ?? 50,
        useIndex,
      });
      print(
        json,
        { workspace: target, sessions: refs },
        [
          `workspace ${target}`,
          `sessions  ${refs.length} across ${new Set(refs.map((r) => r.provider)).size} agents`,
          '',
          ...refs.map(
            (ref) => `${ref.provider.padEnd(11)} ${ref.id.slice(0, 8)}  ${ref.updatedAt ?? '?'}  ${oneLine(ref.title, 70)}`,
          ),
        ].join('\n'),
      );
      break;
    }

    case 'turns': {
      const session = await load(positional[0]);
      const summaries = summarizeTurns(session);
      print(
        json,
        summaries,
        [
          `${summaries.length} 轮 · 共 ${session.turns.length} 个事件`,
          '',
          ...summaries.flatMap((turn) => [
            `${TURN_MARK[turn.status] ?? '·'} T${String(turn.no).padStart(2, ' ')} ${turn.startedAt?.slice(0, 19) ?? '?'}` +
              `${turn.durationMs ? ` (${Math.round(turn.durationMs / 1000)}s)` : ''}` +
              `  事件 ${turn.events[0]}–${turn.events[1]}` +
              `  文件 ${turn.files.length} · 命令 ${turn.commands} · 失败 ${turn.errors}` +
              `${turn.status === 'completed' ? '' : `  [${turn.status}${turn.nudgeCount > 1 ? ` ×${turn.nudgeCount}` : ''}]`}`,
            ...(turn.evidence.length ? [`    ! ${turn.evidence.join('；')}`] : []),
            `    ▸ ${turn.prompt}`,
            ...(turn.outcome ? [`    ◂ ${turn.outcome}`] : []),
          ]),
        ].join('\n'),
      );
      break;
    }

    case 'turn': {
      const session = await load(positional[0]);
      const eventIndex = num(flags.event);
      if (eventIndex !== undefined) {
        const detail = await eventDetail(session, eventIndex);
        const body = detail.fullText ?? detail.text ?? detail.toolResult ?? '';
        print(
          json,
          detail,
          [
            `#${detail.index} ${detail.kind}${detail.toolName ? `(${detail.toolName})` : ''} ${detail.timestamp ?? ''}` +
              `${detail.truncated ? (detail.fullText ? '  [已从 steps/ 补全]' : '  [已截断]') : ''}`,
            ...(detail.toolArgs ? ['', '参数：', JSON.stringify(detail.toolArgs, null, 2)] : []),
            ...(body ? ['', '内容：', body] : []),
            ...(detail.truncationNote ? ['', `⚠️ ${detail.truncationNote}`] : []),
          ].join('\n'),
        );
        break;
      }
      const detail = turnDetail(session, num(positional[1]) ?? 1);
      print(
        json,
        detail,
        [
          `T${detail.summary.no}  ${detail.summary.startedAt ?? '?'} → ${detail.summary.endedAt ?? '?'}` +
            `  事件 ${detail.summary.events[0]}–${detail.summary.events[1]}`,
          `▸ ${detail.summary.prompt}`,
          ...(detail.summary.files.length ? ['', `改动：${detail.summary.files.join(', ')}`] : []),
          '',
          ...detail.events.map((event) => {
            const head = `#${event.index} ${event.kind}${event.toolName ? `(${event.toolName})` : ''}` +
              `${event.truncated ? ' [截断]' : ''}${event.isError ? ' ✗' : ''}`;
            return `${head}  ${oneLine(event.text ?? event.toolResult ?? JSON.stringify(event.toolArgs), 160)}`;
          }),
          '',
          `（用 --event <k> 展开单个事件的完整内容）`,
        ].join('\n'),
      );
      break;
    }

    case 'search': {
      const query = positional.join(' ');
      const hits = await searchSessions(query, {
        workspace: scopeWorkspace(flags),
        since: str(flags.since),
        limit: num(flags.limit),
        provider: str(flags.provider) as never,
        kinds: kindsOf(flags.kind),
        regex: flags.regex === true,
        caseSensitive: flags.case === true,
        context: num(flags.context),
        maxPerSession: num(flags['max-hits']),
        useIndex,
      });
      const total = hits.reduce((sum, hit) => sum + hit.totalMatches, 0);
      print(
        json,
        hits,
        hits.length
          ? [
              `${total} 处命中，分布在 ${hits.length} 个会话`,
              ...hits.flatMap((hit) => [
                '',
                `### ${hit.session.provider} ${hit.session.id.slice(0, 8)}  ` +
                  `${hit.session.createdAt ?? '?'} → ${hit.session.updatedAt ?? '?'}  (${hit.totalMatches} 命中)`,
                `    ${oneLine(hit.session.title, 80)}`,
                ...hit.matches.map(
                  (match) =>
                    `  #${match.index} ${match.kind}${match.toolName ? `(${match.toolName})` : ''}  ${match.excerpt}`,
                ),
                ...(hit.totalMatches > hit.matches.length
                  ? [`  …另有 ${hit.totalMatches - hit.matches.length} 处（--max-hits 调大或 --json 查看全部）`]
                  : []),
              ]),
            ].join('\n')
          : `无命中：${query}`,
      );
      break;
    }

    case 'index': {
      const { openStore } = await import('../src/store/db.js');
      const { indexSession } = await import('../src/store/indexer.js');
      const { deriveEdges } = await import('../src/store/edges.js');
      const { readSession, sessionRow } = await import('../src/store/read.js');
      const { listResolvedSessions } = await import('../src/resolver.js');
      const db = await openStore();
      const force = flags.force === true;

      if (flags.all !== true) {
        const target = positional[0];
        if (!target) throw new Error('missing <session-id> (or pass --all)');
        const { resolveSession } = await import('../src/resolver.js');
        const handle = await resolveSession(target);
        if (!handle) throw new Error(`session not found: ${target}`);
        const result = await indexSession(db, handle, { force });
        print(json, result, `${result.id}  ${result.action}  ${result.session.turns.length} 个事件`);
        break;
      }

      // Backfill indexes L1+L2 first and derives edges in a second pass, so a
      // reference to a session that had not been indexed yet still lands.
      const started = Date.now();
      const handles = await listResolvedSessions({
        limit: num(flags.limit) ?? Number.POSITIVE_INFINITY,
        scan: num(flags.scan) ?? Number.POSITIVE_INFINITY,
        workspace: scopeWorkspace(flags),
        ...(str(flags.since) ? { since: str(flags.since)! } : {}),
        ...(str(flags.provider) ? { provider: str(flags.provider) as never } : {}),
      });
      const counts: Record<string, number> = {};
      for (const handle of handles) {
        const result = await indexSession(db, handle, { force, edges: false });
        counts[result.action] = (counts[result.action] ?? 0) + 1;
      }
      let edges = 0;
      for (const handle of handles) {
        const id = `${handle.adapter.provider}:${handle.candidate.id}`;
        const row = sessionRow(db, id);
        if (row) edges += deriveEdges(db, id, readSession(db, row));
      }
      const summary = {
        sessions: handles.length,
        actions: counts,
        edges,
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      };
      print(
        json,
        summary,
        `已索引 ${summary.sessions} 个会话，耗时 ${summary.seconds}s\n` +
          Object.entries(counts)
            .map(([action, n]) => `  ${action.padEnd(16)} ${n}`)
            .join('\n') +
          `\n  边证据             ${edges}`,
      );
      break;
    }

    case 'graph':
    case 'related': {
      // An inbound edge is the same fact read from the other end.
      const INVERSE: Record<string, string> = {
        references: 'referenced_by',
        handoff_from: 'handed_off_to',
        forked_from: 'forked_into',
        resumed_from: 'resumed_into',
        sends_to: 'sent_from',
      };
      const { openStore } = await import('../src/store/db.js');
      const { edgeEvidence, edgesOf } = await import('../src/store/edges.js');
      const { findSessionRow } = await import('../src/store/read.js');
      const target = positional[0];
      if (!target) throw new Error('missing <session-id>');
      await load(target); // make sure it is indexed before we look it up
      const db = await openStore();
      const row = findSessionRow(db, target);
      if (!row) throw new Error(`session not found: ${target}`);
      const edges = edgesOf(db, row.id).map((edge) => ({
        ...edge,
        evidence: edgeEvidence(db, edge.from, edge.to, edge.relation),
      }));
      print(
        json,
        { session: row.id, edges },
        edges.length
          ? [
              `${row.id}　${oneLine(row.title ?? '', 60)}`,
              '',
              ...edges.map((edge) =>
                edge.direction === 'out'
                  ? `  → ${edge.relation.padEnd(13)} ${edge.to}　证据 ${edge.evidenceCount} 次` +
                    `（${edge.evidence.map((item) => item.operation).join(' ')}）`
                  : `  ← ${(INVERSE[edge.relation] ?? edge.relation).padEnd(13)} ${edge.from}　证据 ${edge.evidenceCount} 次` +
                    `（${edge.evidence.map((item) => item.operation).join(' ')}）`,
              ),
              '',
              '> → 本会话查过对方；← 对方查过本会话。证据可下钻：1session turn <会话> <轮次>',
            ].join('\n')
          : `${row.id} 尚无关系边（没有任何会话通过 1session 查过它，它也没查过别人）`,
      );
      break;
    }

    case 'serve': {
      const { serve, DEFAULT_PORT } = await import('../src/serve/http.js');
      await serve({
        port: num(flags.port) ?? DEFAULT_PORT,
        ...(str(flags.host) ? { host: str(flags.host)! } : {}),
        ...(str(flags.token) ? { token: str(flags.token)! } : {}),
        ...(str(flags['base-url']) ? { baseUrl: str(flags['base-url'])! } : {}),
        ...(flags['no-report'] === true ? { report: false } : {}),
      });
      // The server owns the process from here; nothing after this resolves.
      await new Promise(() => {});
      break;
    }

    case 'skill': {
      const {
        describeState, installSkill, skillStatus, uninstallSkill, bundledSkillDir,
      } = await import('../src/skill.js');
      const agents = str(flags.agent)
        ?.split(',')
        .map((name) => name.trim())
        .filter(Boolean) as ('claude' | 'codex' | 'antigravity')[] | undefined;
      const options = {
        ...(agents?.length ? { agents } : {}),
        mode: flags.copy === true ? ('copy' as const) : ('link' as const),
        force: flags.force === true,
        dryRun: flags['dry-run'] === true,
      };
      const action = positional[0] ?? 'status';

      if (action === 'status') {
        const rows = skillStatus();
        print(
          json,
          { source: bundledSkillDir(), agents: rows },
          [
            `skill 源：${bundledSkillDir()}`,
            '',
            ...rows.map(
              (row) =>
                `  ${row.agent.padEnd(12)} ${row.installed ? '✓' : '·'} ${describeState(row.state).padEnd(28)} ${row.entryPath}`,
            ),
            '',
            '> ✓ = 该智能体已安装。1session skill install 装入，--copy 用拷贝代替链接。',
          ].join('\n'),
        );
        break;
      }
      if (action === 'install' || action === 'uninstall') {
        const results =
          action === 'install' ? await installSkill(options) : await uninstallSkill(options);
        print(
          json,
          results,
          results
            .map((row) => `  ${row.agent.padEnd(12)} ${row.action.padEnd(10)} ${row.note}`)
            .join('\n') || '  无目标',
        );
        break;
      }
      throw new Error(`unknown skill action: ${action}（install | status | uninstall）`);
    }

    default:
      console.log(USAGE);
      if (command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`1session: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
