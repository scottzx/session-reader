import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.js';
import { canonicalizePath } from '../util/paths.js';
import { oneLine, stripPromptEnvelope } from '../util/text.js';
import type { NormalizedSession, SessionRef, TurnEvent } from '../types.js';
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
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  customTitle?: string;
  title?: string;
  message?: { role?: string; content?: unknown };
}

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
          case 'tool_result':
            push({
              kind: 'tool_result',
              toolResult: flattenResult(block.content),
              isError: block.is_error === true,
              timestamp,
            });
            break;
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
    };
  },
};
