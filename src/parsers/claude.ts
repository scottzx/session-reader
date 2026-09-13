import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.js';
import { canonicalizePath } from '../util/paths.js';
import { oneLine, stripPromptEnvelope } from '../util/text.js';
import {
  emptyProviderStats,
  type NormalizedSession,
  type SessionRef,
  type TokenUsage,
  type TurnEvent,
} from '../types.js';
import { toolArgsOf, type ProviderAdapter, type SessionCandidate } from './provider.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}

interface Entry {
  type?: string;
  uuid?: string;
  requestId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  customTitle?: string;
  title?: string;
  attachment?: { type?: string };
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
    model?: string;
    usage?: Record<string, number>;
  };
}

/** Claude prefixes a failed shell result with its exit status. */
const EXIT_CODE = /^\s*Exit code (\d+)/;

/** `tool_result.content` is either a string or a list of text blocks. */
function flattenResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : ((block as Block)?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

export const claudeAdapter: ProviderAdapter = {
  provider: 'claude',

  async listCandidates(): Promise<SessionCandidate[]> {
    let projects: string[];
    try {
      projects = await fs.readdir(PROJECTS_DIR);
    } catch {
      return [];
    }
    const found: SessionCandidate[] = [];
    for (const project of projects) {
      const dir = path.join(PROJECTS_DIR, project);
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const full = path.join(dir, file);
        const stat = await fs.stat(full).catch(() => undefined);
        if (!stat?.isFile()) continue;
        found.push({
          id: file.replace(/\.jsonl$/, ''),
          path: full,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
        });
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  },

  /**
   * Only the head of the file is read, so the title is the opening request —
   * a session's own `custom-title`/`ai-title` is picked up by {@link parse}.
   */
  async scanRef(candidate: SessionCandidate): Promise<SessionRef> {
    let title: string | undefined;
    let workspace: string | undefined;
    let createdAt: string | undefined;
    for await (const raw of readJsonl(candidate.path, { maxLines: 60 })) {
      const entry = raw as Entry;
      if (entry.cwd) workspace ??= canonicalizePath(entry.cwd);
      createdAt ??= entry.timestamp;
      if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle;
      if (!title && entry.type === 'user' && !entry.isMeta && typeof entry.message?.content === 'string') {
        title = oneLine(stripPromptEnvelope(entry.message.content), 120);
      }
      if (title && workspace) break;
    }
    return {
      id: candidate.id,
      provider: 'claude',
      path: candidate.path,
      title,
      workspace,
      createdAt,
      updatedAt: new Date(candidate.mtimeMs).toISOString(),
      sizeBytes: candidate.sizeBytes,
    };
  },

  async parse(candidate: SessionCandidate): Promise<NormalizedSession> {
    const turns: TurnEvent[] = [];
    const stats = emptyProviderStats();
    const tokens: TokenUsage = { input: 0, output: 0, total: 0 };
    let cacheRead = 0;
    // One assistant message can appear on several entries; count its usage once.
    const countedUsage = new Set<string>();
    let title: string | undefined;
    let firstPrompt: string | undefined;
    let workspace: string | undefined;
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    const push = (turn: Omit<TurnEvent, 'id' | 'index'>) => {
      turns.push({ ...turn, index: turns.length, id: `${candidate.id}#${turns.length}` });
    };

    for await (const raw of readJsonl(candidate.path)) {
      const entry = raw as Entry;
      if (entry.cwd) workspace ??= canonicalizePath(entry.cwd);
      if (entry.timestamp) {
        createdAt ??= entry.timestamp;
        updatedAt = entry.timestamp;
      }
      if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle;
      if (entry.type === 'ai-title' && typeof entry.title === 'string') title ??= entry.title;

      if (entry.gitBranch && !stats.branches.includes(entry.gitBranch)) stats.branches.push(entry.gitBranch);
      const model = entry.message?.model;
      if (model && !stats.models.includes(model)) stats.models.push(model);
      const usage = entry.message?.usage;
      const usageKey = entry.message?.id ?? entry.requestId ?? entry.uuid;
      if (usage && usageKey && !countedUsage.has(usageKey)) {
        countedUsage.add(usageKey);
        // Cache reads are prefix replays, not input: counting them as input
        // turns a 200k-context session into "116M tokens".
        tokens.input += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        tokens.output += usage.output_tokens ?? 0;
        cacheRead += usage.cache_read_input_tokens ?? 0;
      }
      if (entry.isSidechain) stats.extras.sidechain = (stats.extras.sidechain ?? 0) + 1;
      if (entry.type === 'attachment' && entry.attachment?.type) {
        const key = `attachment:${entry.attachment.type}`;
        stats.extras[key] = (stats.extras[key] ?? 0) + 1;
      }
      if (entry.type === 'file-history-snapshot') {
        stats.extras.fileSnapshots = (stats.extras.fileSnapshots ?? 0) + 1;
      }
      if (entry.isMeta) continue;

      const timestamp = entry.timestamp;
      const content = entry.message?.content;

      if (entry.type === 'user' && typeof content === 'string') {
        const text = stripPromptEnvelope(content);
        if (!text) continue;
        firstPrompt ??= oneLine(text, 120);
        push({ kind: 'user', text, timestamp });
        continue;
      }
      if (!Array.isArray(content)) continue;

      for (const block of content as Block[]) {
        switch (block.type) {
          case 'text':
            if (block.text?.trim()) push({ kind: 'assistant', text: block.text, timestamp });
            break;
          case 'thinking':
            if (block.thinking?.trim()) push({ kind: 'thinking', text: block.thinking, timestamp });
            break;
          case 'tool_use':
            push({
              kind: 'tool_call',
              toolName: block.name,
              toolArgs: toolArgsOf(block.input),
              timestamp,
            });
            break;
          case 'tool_result': {
            const text = flattenResult(block.content);
            const exit = EXIT_CODE.exec(text);
            push({
              kind: 'tool_result',
              toolResult: text,
              isError: block.is_error === true,
              timestamp,
              ...(exit ? { exitCode: Number(exit[1]) } : {}),
            });
            break;
          }
          default:
            break;
        }
      }
    }

    return {
      ref: {
        id: candidate.id,
        provider: 'claude',
        path: candidate.path,
        title: title ?? firstPrompt,
        workspace,
        createdAt,
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
