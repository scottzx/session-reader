import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.js';
import { readZstdJsonl } from '../util/zstd.js';
import { canonicalizePath } from '../util/paths.js';
import { looksLikeInstructions, oneLine, stripPromptEnvelope } from '../util/text.js';
import { toolArgsOf, type ProviderAdapter, type SessionCandidate } from './provider.js';
import {
  emptyProviderStats,
  type NormalizedSession,
  type SessionRef,
  type TokenUsage,
  type TurnEvent,
} from '../types.js';

/** DeepSeek Harness keeps one directory per session under a slugified cwd. */
const SESSIONS_DIR = path.join(os.homedir(), '.dsh', 'sessions');
const SESSION_DIR = /^session-([0-9a-fA-F-]{36})$/;
/** Written compressed; the plain spelling is read too, in case it ever is. */
const TRANSCRIPTS = ['session.v2.jsonl', 'session.v2.jsonl.zstd'];

interface Block {
  type?: string;
  text?: string;
  isError?: boolean;
  content?: Block[];
}

interface Message {
  role?: string;
  content?: Block[];
  source?: { kind?: string; provider?: string; model?: string };
}

interface Line {
  type?: string;
  seq?: number;
  /** Epoch milliseconds — every record but `session` carries one. */
  time?: number;
  data?: Record<string, unknown>;
  /** Only on the opening `session` record. */
  id?: string;
  cwd?: string;
  createdAt?: number;
  agentPreset?: string;
  delegationDepth?: number;
}

/** The harness appends the status of a failed shell command to its output. */
const EXIT_CODE = /\[exit code:\s*(\d+)\]\s*$/i;

/** The harness injects catalogues and instructions as user messages. */
function isRealUser(source: { kind?: string } | undefined): boolean {
  return (source?.kind ?? 'user') === 'user';
}

function textOf(blocks: Block[] | undefined): string {
  return (blocks ?? [])
    .map((block) => block?.text ?? '')
    .filter(Boolean)
    .join('\n');
}

function stamp(time: number | undefined): string | undefined {
  return typeof time === 'number' && time > 0 ? new Date(time).toISOString() : undefined;
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return toolArgsOf(JSON.parse(value)) ?? { input: value };
    } catch {
      return { input: value };
    }
  }
  return toolArgsOf(value);
}

/** Dispatches on the extension so both spellings read the same way. */
function readLines(file: string, headBytes?: number): AsyncGenerator<Record<string, unknown>> {
  if (file.endsWith('.zstd')) {
    return readZstdJsonl(file, { ...(headBytes ? { headBytes } : {}) });
  }
  // A plain transcript is line-oriented, so a head read is a line budget.
  return readJsonl(file, headBytes ? { maxLines: 200 } : {});
}

/** `sessions/<slugified cwd>/session-<uuid>/session.v2.jsonl[.zstd]`. */
async function transcriptPath(dir: string): Promise<string | undefined> {
  for (const name of TRANSCRIPTS) {
    const full = path.join(dir, name);
    if (await fs.stat(full).then((stat) => stat.isFile()).catch(() => false)) return full;
  }
  return undefined;
}

export const dshAdapter: ProviderAdapter = {
  provider: 'dsh',

  async listCandidates(): Promise<SessionCandidate[]> {
    let projects: string[];
    try {
      projects = await fs.readdir(SESSIONS_DIR);
    } catch {
      return [];
    }
    const found: SessionCandidate[] = [];
    for (const project of projects) {
      const dir = path.join(SESSIONS_DIR, project);
      for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
        // The directory is `session-<uuid>`; the id is the uuid, so a short id
        // means the same thing here as it does for every other provider.
        const id = SESSION_DIR.exec(entry)?.[1];
        if (!id) continue;
        const file = await transcriptPath(path.join(dir, entry));
        if (!file) continue;
        const stat = await fs.stat(file).catch(() => undefined);
        if (!stat) continue;
        found.push({ id, path: file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  },

  async scanRef(candidate: SessionCandidate): Promise<SessionRef> {
    let title: string | undefined;
    let workspace: string | undefined;
    let createdAt: string | undefined;
    // Frames are self-delimiting, so a head read decodes to a head of the
    // session — enough for the opening record and the title that follows it.
    for await (const raw of readLines(candidate.path, 64 * 1024)) {
      const line = raw as Line;
      if (line.type === 'session') {
        createdAt ??= stamp(line.createdAt);
        if (typeof line.cwd === 'string') workspace ??= canonicalizePath(line.cwd);
        continue;
      }
      const data = line.data ?? {};
      // The harness titles a session from its first prompt; that title wins.
      if (line.type === 'session/title' && typeof data.title === 'string') title = data.title;
      if (!title && line.type === 'user/message' && isRealUser(data.source as Message['source'])) {
        const text = stripPromptEnvelope(textOf(data.content as Block[]));
        if (text && !looksLikeInstructions(text)) title = oneLine(text, 120);
      }
    }
    return {
      id: candidate.id,
      provider: 'dsh',
      path: candidate.path,
      // Spread rather than assign: the index stores an absent column as absent,
      // so an explicit `undefined` would make a cached ref differ from a parsed
      // one — and a session can genuinely be opened without ever being titled.
      ...(title ? { title } : {}),
      ...(workspace ? { workspace } : {}),
      ...(createdAt ? { createdAt } : {}),
      updatedAt: new Date(candidate.mtimeMs).toISOString(),
      sizeBytes: candidate.sizeBytes,
    };
  },

  async parse(candidate: SessionCandidate): Promise<NormalizedSession> {
    const turns: TurnEvent[] = [];
    const stats = emptyProviderStats();
    const tokens: TokenUsage = { input: 0, output: 0, total: 0 };
    let cacheRead = 0;
    let title: string | undefined;
    let firstPrompt: string | undefined;
    let workspace: string | undefined;
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    // An explicit `timestamp: undefined` is not the same object as one without
    // the key, and the index stores absent columns as absent — so a session read
    // back from it would stop deep-equalling a fresh parse.
    const push = ({ timestamp, ...turn }: Omit<TurnEvent, 'id' | 'index'>) => {
      turns.push({
        ...turn,
        ...(timestamp ? { timestamp } : {}),
        index: turns.length,
        id: `${candidate.id}#${turns.length}`,
      });
    };
    const count = (key: string) => {
      stats.extras[key] = (stats.extras[key] ?? 0) + 1;
    };

    for await (const raw of readLines(candidate.path)) {
      const line = raw as Line;
      if (line.type === 'session') {
        createdAt ??= stamp(line.createdAt);
        if (typeof line.cwd === 'string') workspace ??= canonicalizePath(line.cwd);
        if (line.delegationDepth) stats.extras.delegationDepth = line.delegationDepth;
        continue;
      }
      const timestamp = stamp(line.time);
      if (timestamp) updatedAt = timestamp;
      const data = line.data ?? {};

      switch (line.type) {
        case 'session/title':
          if (typeof data.title === 'string') title = data.title;
          break;
        case 'model/selection':
        case 'request/context': {
          const model = data.model as string | undefined;
          if (model && !stats.models.includes(model)) stats.models.push(model);
          break;
        }
        case 'turn/start':
          stats.turnBoundaries.push({
            id: String(data.turn ?? stats.turnBoundaries.length + 1),
            ...(timestamp ? { startedAt: timestamp } : {}),
            completed: false,
          });
          break;
        case 'turn/end': {
          const id = String(data.turn ?? '');
          const match = stats.turnBoundaries.find((boundary) => boundary.id === id && !boundary.completed);
          const reason = (data.reason as { kind?: string } | undefined)?.kind ?? 'completed';
          // `interrupted` and `aborted` end a turn without finishing it.
          if (match && reason === 'completed') {
            match.completed = true;
            if (timestamp) match.endedAt = timestamp;
            if (match.startedAt && timestamp) {
              match.durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(match.startedAt));
            }
          }
          if (reason !== 'completed') count(`turn:${reason}`);
          break;
        }
        case 'user/message': {
          const source = data.source as Message['source'];
          if (!isRealUser(source)) {
            count(`injected:${source?.kind ?? 'unknown'}`);
            break;
          }
          const text = stripPromptEnvelope(textOf(data.content as Block[]));
          if (!text || looksLikeInstructions(text)) break;
          firstPrompt ??= oneLine(text, 120);
          push({ kind: 'user', text, timestamp });
          break;
        }
        case 'assistant/message': {
          const message = (data.message ?? {}) as Message;
          const model = message.source?.model;
          if (model && !stats.models.includes(model)) stats.models.push(model);
          const usage = data.usage as Record<string, number> | undefined;
          if (usage) {
            tokens.input += usage.inputTokens ?? 0;
            tokens.output += usage.outputTokens ?? 0;
            cacheRead += usage.cacheReadTokens ?? 0;
          }
          for (const block of message.content ?? []) {
            // `tool-call` blocks restate the `tool/call` records that follow;
            // taking both would double every tool call in the timeline.
            if (block.type === 'reasoning' && block.text?.trim()) {
              push({ kind: 'thinking', text: block.text, timestamp });
            } else if (block.type === 'text' && block.text?.trim()) {
              push({ kind: 'assistant', text: block.text, timestamp });
            }
          }
          break;
        }
        case 'tool/call':
          push({
            kind: 'tool_call',
            toolName: data.name as string | undefined,
            toolArgs: parseArguments(data.arguments),
            timestamp,
          });
          break;
        case 'tool/result': {
          const message = (data.message ?? {}) as Message;
          const result = (message.content ?? []).find((block) => block.type === 'tool-result');
          const text = textOf(result?.content);
          const exit = EXIT_CODE.exec(text.trimEnd());
          push({
            kind: 'tool_result',
            toolResult: text,
            isError: result?.isError === true,
            timestamp,
            ...(exit ? { exitCode: Number(exit[1]) } : {}),
          });
          break;
        }
        case 'approval/asked':
          count('approvals');
          break;
        case 'subagent/descriptor':
          count('subagents');
          break;
        case 'step/start':
          count('steps');
          break;
        default:
          break;
      }
    }

    return {
      ref: {
        id: candidate.id,
        provider: 'dsh',
        path: candidate.path,
        ...(title || firstPrompt ? { title: title ?? firstPrompt } : {}),
        ...(workspace ? { workspace } : {}),
        ...(createdAt ? { createdAt } : {}),
        updatedAt: updatedAt ?? new Date(candidate.mtimeMs).toISOString(),
        sizeBytes: candidate.sizeBytes,
      },
      turns,
      artifacts: [],
      stats: {
        ...stats,
        ...(tokens.input || tokens.output
          ? {
              tokens: {
                ...tokens,
                total: tokens.input + tokens.output,
                ...(cacheRead ? { cacheRead } : {}),
              },
            }
          : {}),
      },
    };
  },
};
