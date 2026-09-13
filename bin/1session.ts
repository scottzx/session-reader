#!/usr/bin/env node
import path from 'node:path';
import { aggregateWorkspaceSessions } from '../src/aggregator.js';
import { distillSession } from '../src/distiller.js';
import { listRecentSessions, resolveSession } from '../src/resolver.js';
import { searchSessions } from '../src/search.js';
import { canonicalizePath } from '../src/util/paths.js';
import { oneLine } from '../src/util/text.js';
import type { DigestFocus, NormalizedSession, TurnKind } from '../src/types.js';

const USAGE = `1session — cross-agent session Read Plane

  1session list [--limit <n>] [--workspace <path>] [--provider <name>] [--since 24h] [--json]
  1session inspect <session-id> [--json]
  1session digest <session-id> [--focus marketing|review|full] [--json]
  1session workspace [path] [--since 24h] [--limit <n>] [--digest] [--focus <f>] [--json]
  1session turns <session-id> [-n <turn-index>] [--json]
  1session search <query> [--workspace path] [--since 24h] [--limit n] [--provider name]
                          [--kind user,assistant,thinking,tool_call,tool_result]
                          [--regex] [--case] [--context n] [--max-hits n] [--json]

Providers: antigravity (~/.gemini/antigravity/brain), claude (~/.claude/projects), codex (~/.codex/sessions).
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

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
      if (next && !next.startsWith('--')) {
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

const str = (value: string | boolean | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;
const num = (value: string | boolean | undefined): number | undefined => {
  const parsed = Number(str(value));
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

function print(json: boolean, data: unknown, text: string): void {
  console.log(json ? JSON.stringify(data, null, 2) : text);
}

async function load(sessionId: string | undefined): Promise<NormalizedSession> {
  if (!sessionId) throw new Error('missing <session-id>');
  const resolved = await resolveSession(sessionId);
  if (!resolved) throw new Error(`session not found: ${sessionId}`);
  return resolved.adapter.parse(resolved.candidate);
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === true;

  switch (command) {
    case 'list': {
      const refs = await listRecentSessions({
        limit: num(flags.limit) ?? 20,
        workspace: str(flags.workspace),
        since: str(flags.since),
        provider: str(flags.provider) as never,
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

    case 'inspect': {
      const session = await load(positional[0]);
      const counts = session.turns.reduce<Record<string, number>>((acc, turn) => {
        acc[turn.kind] = (acc[turn.kind] ?? 0) + 1;
        return acc;
      }, {});
      print(
        json,
        { ...session.ref, turnCount: session.turns.length, counts, artifacts: session.artifacts.map((a) => a.path) },
        [
          `id        ${session.ref.id}`,
          `provider  ${session.ref.provider}`,
          `title     ${session.ref.title ?? '-'}`,
          `workspace ${session.ref.workspace ?? '-'}`,
          `time      ${session.ref.createdAt ?? '?'} → ${session.ref.updatedAt ?? '?'}`,
          `file      ${session.ref.path}`,
          `turns     ${session.turns.length} (${Object.entries(counts)
            .map(([kind, count]) => `${kind}:${count}`)
            .join(' ')})`,
          `artifacts ${session.artifacts.map((a) => a.name).join(', ') || '-'}`,
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
      const index = num(flags.n);
      if (index !== undefined) {
        const turn = session.turns[index];
        if (!turn) throw new Error(`no turn ${index} (session has ${session.turns.length})`);
        print(
          json,
          turn,
          [
            `#${turn.index} ${turn.kind}${turn.toolName ? `(${turn.toolName})` : ''} ${turn.timestamp ?? ''}`,
            '',
            turn.text ?? turn.toolResult ?? JSON.stringify(turn.toolArgs, null, 2) ?? '',
          ].join('\n'),
        );
        break;
      }
      print(
        json,
        session.turns,
        session.turns
          .map(
            (turn) =>
              `${String(turn.index).padStart(4, ' ')} ${turn.kind.padEnd(11)}` +
              `${(turn.toolName ?? '').padEnd(18)} ${oneLine(turn.text ?? turn.toolResult, 90)}`,
          )
          .join('\n'),
      );
      break;
    }

    case 'search': {
      const query = positional.join(' ');
      const hits = await searchSessions(query, {
        workspace: str(flags.workspace),
        since: str(flags.since),
        limit: num(flags.limit),
        provider: str(flags.provider) as never,
        kinds: kindsOf(flags.kind),
        regex: flags.regex === true,
        caseSensitive: flags.case === true,
        context: num(flags.context),
        maxPerSession: num(flags['max-hits']),
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

    default:
      console.log(USAGE);
      if (command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`1session: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
