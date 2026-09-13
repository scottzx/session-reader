import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.js';
import { canonicalizePath, findRepoRoot } from '../util/paths.js';
import { clip, oneLine, stripPromptEnvelope } from '../util/text.js';
import type { NormalizedSession, SessionArtifact, SessionRef, TurnEvent } from '../types.js';
import type { ProviderAdapter, SessionCandidate } from './provider.js';

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const TRANSCRIPTS = ['transcript.jsonl', 'transcript_full.jsonl'];
/** Args whose value is an absolute path we can use to locate the repository. */
const PATH_ARGS = ['AbsolutePath', 'DirectoryPath', 'SearchPath', 'TargetFile', 'FilePath'];

interface Step {
  step_index?: number;
  source?: string;
  type?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: { name?: string; args?: Record<string, unknown> }[];
}

/** Antigravity double-encodes every tool argument as a JSON string. */
function unwrapArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(args ?? {})) {
    if (typeof raw === 'string') {
      try {
        out[key] = JSON.parse(raw);
        continue;
      } catch {
        /* plain string */
      }
    }
    out[key] = raw;
  }
  return out;
}

function workspaceFromCall(name: string | undefined, args: Record<string, unknown>): string | undefined {
  if (name === 'run_command' && typeof args.Cwd === 'string' && args.Cwd) {
    return canonicalizePath(args.Cwd);
  }
  for (const key of PATH_ARGS) {
    const value = args[key];
    if (typeof value === 'string' && value) {
      const root = findRepoRoot(value);
      if (root) return root;
    }
  }
  return undefined;
}

async function transcriptPath(dir: string): Promise<string | undefined> {
  for (const name of TRANSCRIPTS) {
    const file = path.join(dir, '.system_generated', 'logs', name);
    try {
      await fs.access(file);
      return file;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function readArtifacts(dir: string): Promise<SessionArtifact[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const artifacts: SessionArtifact[] = [];
  for (const name of entries.filter((n) => n.endsWith('.md')).sort()) {
    const file = path.join(dir, name);
    artifacts.push({ name, path: file, content: await fs.readFile(file, 'utf8').catch(() => undefined) });
  }
  return artifacts;
}

export const antigravityAdapter: ProviderAdapter = {
  provider: 'antigravity',

  async listCandidates(): Promise<SessionCandidate[]> {
    let dirs: string[];
    try {
      dirs = await fs.readdir(BRAIN_DIR);
    } catch {
      return [];
    }
    const found: SessionCandidate[] = [];
    for (const id of dirs) {
      if (id.startsWith('.')) continue;
      const file = await transcriptPath(path.join(BRAIN_DIR, id));
      if (!file) continue;
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat) continue;
      found.push({ id, path: file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  },

  async scanRef(candidate: SessionCandidate): Promise<SessionRef> {
    let title: string | undefined;
    let workspace: string | undefined;
    let createdAt: string | undefined;
    for await (const raw of readJsonl(candidate.path, { maxLines: 400 })) {
      const step = raw as Step;
      createdAt ??= step.created_at;
      if (!title && step.type === 'USER_INPUT' && step.content) {
        title = oneLine(stripPromptEnvelope(step.content), 120);
      }
      for (const call of step.tool_calls ?? []) {
        workspace ??= workspaceFromCall(call.name, unwrapArgs(call.args));
      }
      if (title && workspace) break;
    }
    return {
      id: candidate.id,
      provider: 'antigravity',
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
    let workspace: string | undefined;
    let createdAt: string | undefined;

    const push = (turn: Omit<TurnEvent, 'id' | 'index'>) => {
      turns.push({ ...turn, index: turns.length, id: `${candidate.id}#${turns.length}` });
    };

    for await (const raw of readJsonl(candidate.path)) {
      const step = raw as Step;
      const timestamp = step.created_at;
      createdAt ??= timestamp;

      if (step.type === 'USER_INPUT' && step.content) {
        const text = stripPromptEnvelope(step.content);
        title ??= oneLine(text, 120);
        push({ kind: 'user', text, timestamp });
        continue;
      }
      if (step.thinking) push({ kind: 'thinking', text: step.thinking, timestamp });
      if (step.type === 'PLANNER_RESPONSE' && step.content) {
        push({ kind: 'assistant', text: step.content, timestamp });
      }
      for (const call of step.tool_calls ?? []) {
        const args = unwrapArgs(call.args);
        workspace ??= workspaceFromCall(call.name, args);
        push({ kind: 'tool_call', toolName: call.name, toolArgs: args, timestamp });
      }
      if (step.type === 'GENERIC' && step.content) {
        push({
          kind: 'tool_result',
          toolResult: step.content,
          isError: /Encountered error|Error:|command failed/i.test(step.content.slice(0, 400)),
          timestamp,
        });
      }
    }

    const dir = path.resolve(path.dirname(candidate.path), '..', '..');
    const artifacts = await readArtifacts(dir);
    return {
      ref: {
        id: candidate.id,
        provider: 'antigravity',
        path: candidate.path,
        title: title ?? clip(artifacts[0]?.name, 120),
        workspace,
        createdAt,
        updatedAt: turns.at(-1)?.timestamp ?? new Date(candidate.mtimeMs).toISOString(),
        sizeBytes: candidate.sizeBytes,
      },
      turns,
      artifacts,
    };
  },
};
