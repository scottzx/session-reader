import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.js';
import { canonicalizePath } from '../util/paths.js';
import { looksLikeInstructions, oneLine, stripPromptEnvelope } from '../util/text.js';
import { toolArgsOf, type ProviderAdapter, type SessionCandidate } from './provider.js';
import {
  emptyProviderStats,
  type CommandRecord,
  type FileChange,
  type NormalizedSession,
  type ProviderStats,
  type SessionRef,
  type TokenUsage,
  type TurnEvent,
} from '../types.js';

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const ROLLOUT = /^rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$/;

interface Line {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

/** `event_msg/item_completed` carries codex's own structured record of a step. */
interface CompletedItem {
  type?: string;
  id?: string;
  kind?: string;
  query?: string;
  process_id?: string;
  command?: string[] | string;
  cwd?: string;
  exit_code?: number;
  stderr?: string;
  duration?: { secs?: number; nanos?: number };
  changes?: Record<string, { type?: string; content?: string }>;
}

const SSH_HOST = /\b[\w.-]+@((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[\w-]+(?:\.[\w-]+)+))/;

function durationOf(duration: CompletedItem['duration']): number | undefined {
  if (!duration) return undefined;
  const ms = (duration.secs ?? 0) * 1000 + (duration.nanos ?? 0) / 1e6;
  return ms > 0 ? Math.round(ms) : undefined;
}

const CHANGE_KINDS: Record<string, FileChange['change']> = {
  add: 'add',
  update: 'update',
  delete: 'delete',
};

/**
 * Absorbs the structured side-channel: authoritative file changes, command
 * executions with pids, turn boundaries and token accounting. These mirror the
 * conversation stream, so they feed statistics only — never the turn list.
 */
function absorbEvent(line: Line, stats: ProviderStats, tokens: TokenUsage): void {
  const payload = line.payload ?? {};

  if (line.type === 'token_usage_record') {
    const usage = payload.usage as Record<string, number> | undefined;
    if (usage) {
      tokens.input += usage.input_tokens ?? 0;
      tokens.output += usage.output_tokens ?? 0;
      tokens.total += usage.total_tokens ?? 0;
    }
    return;
  }
  if (line.type === 'event_msg' && payload.type === 'thread_settings_applied') {
    const model = (payload.thread_settings as { model?: string } | undefined)?.model;
    if (model && !stats.models.includes(model)) stats.models.push(model);
    return;
  }
  if (line.type === 'event_msg' && payload.type === 'task_started') {
    stats.turnBoundaries.push({
      id: payload.turn_id as string | undefined,
      startedAt: line.timestamp,
      completed: false,
    });
    return;
  }
  if (line.type === 'event_msg' && payload.type === 'task_complete') {
    const turnId = payload.turn_id as string | undefined;
    // Pair by id: this session starts 12 turns but completes only 9, so
    // matching by position would attribute durations to the wrong turns.
    const match = stats.turnBoundaries.find((boundary) => boundary.id === turnId && !boundary.completed);
    if (match) {
      match.completed = true;
      match.endedAt = line.timestamp;
      match.durationMs = payload.duration_ms as number | undefined;
      match.lastMessage = payload.last_agent_message as string | undefined;
    }
    return;
  }
  if (line.type !== 'event_msg' || payload.type !== 'item_completed') return;

  const item = (payload.item ?? {}) as CompletedItem;
  switch (item.type) {
    case 'FileChange':
      for (const [file, detail] of Object.entries(item.changes ?? {})) {
        stats.fileChanges.push({
          path: canonicalizePath(file),
          change: CHANGE_KINDS[detail?.type ?? ''] ?? 'update',
          sizeBytes: detail?.content?.length,
        });
      }
      break;
    case 'CommandExecution': {
      stats.commandExecutions = (stats.commandExecutions ?? 0) + 1;
      const command = Array.isArray(item.command) ? item.command.join(' ') : (item.command ?? '');
      const record: CommandRecord = {
        eventIndex: -1, // filled in by the ledger, which knows the event stream
        turn: 0,
        command,
        source: 'provider',
        ...(item.process_id ? { pid: item.process_id } : {}),
        ...(item.cwd ? { cwd: canonicalizePath(item.cwd) } : {}),
        ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
        ...(durationOf(item.duration) ? { durationMs: durationOf(item.duration) } : {}),
        ...(item.stderr?.trim() ? { stderr: item.stderr.trim() } : {}),
        ...(line.timestamp ? { timestamp: line.timestamp } : {}),
      };
      const host = SSH_HOST.exec(command)?.[1];
      if (host) record.host = host;
      stats.commands.push(record);
      break;
    }
    case 'Extension':
      stats.extras[`web:${item.kind ?? 'unknown'}`] = (stats.extras[`web:${item.kind ?? 'unknown'}`] ?? 0) + 1;
      break;
    case 'Reasoning':
    case 'AgentMessage':
    case 'UserMessage':
      break;
    default:
      if (item.type) stats.extras[item.type] = (stats.extras[item.type] ?? 0) + 1;
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[])
    .map((block) => block?.text ?? '')
    .filter(Boolean)
    .join('\n');
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

/** Walks `sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`. */
async function walkRollouts(dir: string, out: string[], depth = 0): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 4) await walkRollouts(full, out, depth + 1);
    else if (entry.isFile() && ROLLOUT.test(entry.name)) out.push(full);
  }
}

export const codexAdapter: ProviderAdapter = {
  provider: 'codex',

  async listCandidates(): Promise<SessionCandidate[]> {
    const files: string[] = [];
    await walkRollouts(SESSIONS_DIR, files);
    const found: SessionCandidate[] = [];
    for (const file of files) {
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat) continue;
      found.push({
        id: ROLLOUT.exec(path.basename(file))?.[1] ?? path.basename(file),
        path: file,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  },

  async scanRef(candidate: SessionCandidate): Promise<SessionRef> {
    let title: string | undefined;
    let workspace: string | undefined;
    let createdAt: string | undefined;
    for await (const raw of readJsonl(candidate.path, { maxLines: 120 })) {
      const line = raw as Line;
      const payload = line.payload ?? {};
      if (line.type === 'session_meta') {
        createdAt ??= (payload.timestamp as string) ?? line.timestamp;
        if (typeof payload.cwd === 'string') workspace ??= canonicalizePath(payload.cwd);
      }
      if (!workspace && line.type === 'turn_context' && typeof payload.cwd === 'string') {
        workspace = canonicalizePath(payload.cwd);
      }
      if (!title && line.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        const text = stripPromptEnvelope(textOf(payload.content));
        if (text && !looksLikeInstructions(text)) title = oneLine(text, 120);
      }
      if (title && workspace) break;
    }
    return {
      id: candidate.id,
      provider: 'codex',
      path: candidate.path,
      title,
      workspace,
      createdAt: createdAt ?? timestampFromFilename(candidate.path),
      updatedAt: new Date(candidate.mtimeMs).toISOString(),
      sizeBytes: candidate.sizeBytes,
    };
  },

  async parse(candidate: SessionCandidate): Promise<NormalizedSession> {
    const turns: TurnEvent[] = [];
    const stats = emptyProviderStats();
    const tokens: TokenUsage = { input: 0, output: 0, total: 0 };
    let title: string | undefined;
    let workspace: string | undefined;
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    const push = (turn: Omit<TurnEvent, 'id' | 'index'>) => {
      turns.push({ ...turn, index: turns.length, id: `${candidate.id}#${turns.length}` });
    };

    for await (const raw of readJsonl(candidate.path)) {
      const line = raw as Line;
      const payload = line.payload ?? {};
      const timestamp = line.timestamp;
      if (timestamp) {
        createdAt ??= timestamp;
        updatedAt = timestamp;
      }
      if (line.type === 'session_meta' || line.type === 'turn_context') {
        if (typeof payload.cwd === 'string') workspace ??= canonicalizePath(payload.cwd);
        continue;
      }
      if (line.type !== 'response_item') {
        absorbEvent(line, stats, tokens);
        continue;
      }

      switch (payload.type) {
        case 'message': {
          const text = stripPromptEnvelope(textOf(payload.content));
          if (!text) break;
          if (payload.role === 'assistant') {
            push({ kind: 'assistant', text, timestamp });
          } else if (payload.role === 'user') {
            if (looksLikeInstructions(text)) break;
            title ??= oneLine(text, 120);
            push({ kind: 'user', text, timestamp });
          }
          break;
        }
        case 'reasoning': {
          const summary = Array.isArray(payload.summary)
            ? (payload.summary as ContentBlock[]).map((b) => b?.text ?? '').filter(Boolean).join('\n')
            : '';
          if (summary) push({ kind: 'thinking', text: summary, timestamp });
          break;
        }
        case 'function_call':
          push({
            kind: 'tool_call',
            toolName: payload.name as string | undefined,
            toolArgs: parseArguments(payload.arguments),
            timestamp,
          });
          break;
        case 'custom_tool_call':
          push({
            kind: 'tool_call',
            toolName: payload.name as string | undefined,
            toolArgs: { input: payload.input },
            timestamp,
          });
          break;
        case 'local_shell_call':
          push({
            kind: 'tool_call',
            toolName: 'shell',
            toolArgs: toolArgsOf(payload.action) ?? {},
            timestamp,
          });
          break;
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const output = textOf(payload.output) || String(payload.output ?? '');
          push({
            kind: 'tool_result',
            toolResult: output,
            // A bare "error" substring matches ordinary prose; require a real
            // non-zero exit or a fatal marker at the start of a line.
            isError:
              /"exit_code":\s*[1-9]/.test(output.slice(0, 400)) ||
              /^(?:Traceback|fatal:|error:|[\w.]+Error:)/im.test(output.slice(0, 400)),
            timestamp,
          });
          break;
        }
        default:
          break;
      }
    }

    return {
      ref: {
        id: candidate.id,
        provider: 'codex',
        path: candidate.path,
        title,
        workspace,
        createdAt,
        updatedAt: updatedAt ?? new Date(candidate.mtimeMs).toISOString(),
        sizeBytes: candidate.sizeBytes,
      },
      turns,
      artifacts: [],
      stats: { ...stats, ...(tokens.total ? { tokens } : {}) },
    };
  },
};

function timestampFromFilename(file: string): string | undefined {
  const stamp = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(path.basename(file))?.[1];
  if (!stamp) return undefined;
  const [date, time] = stamp.split('T');
  return `${date}T${time?.replace(/-/g, ':')}`;
}
