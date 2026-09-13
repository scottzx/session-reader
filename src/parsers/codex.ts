import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.js';
import { canonicalizePath } from '../util/paths.js';
import { looksLikeInstructions, oneLine, stripPromptEnvelope } from '../util/text.js';
import { toolArgsOf, type ProviderAdapter, type SessionCandidate } from './provider.js';
import type { NormalizedSession, SessionRef, TurnEvent } from '../types.js';

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
      // `event_msg` mirrors `response_item`; keeping both would double every turn.
      if (line.type !== 'response_item') continue;

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
    };
  },
};

function timestampFromFilename(file: string): string | undefined {
  const stamp = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(path.basename(file))?.[1];
  if (!stamp) return undefined;
  const [date, time] = stamp.split('T');
  return `${date}T${time?.replace(/-/g, ':')}`;
}
