import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.js';
import { canonicalizePath, findRepoRoot } from '../util/paths.js';
import { clip, oneLine, stripPromptEnvelope } from '../util/text.js';
import {
  emptyProviderStats,
  type BackgroundTask,
  type NormalizedSession,
  type ProviderStats,
  type SessionArtifact,
  type SessionRef,
  type TurnEvent,
} from '../types.js';
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
  truncated_fields?: string[];
  tool_calls?: { name?: string; args?: Record<string, unknown> }[];
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const TEXT_EXT = /\.(?:md|txt|json|csv)$/i;

function artifactKind(name: string): SessionArtifact['kind'] {
  if (IMAGE_EXT.test(name)) return 'image';
  return /\.md$/i.test(name) ? 'markdown' : 'other';
}

/** Background jobs: `tasks/task-N.log` is the output, `messages/` the receipts. */
async function readTasks(systemDir: string): Promise<BackgroundTask[]> {
  const tasks = new Map<string, BackgroundTask>();
  for (const name of await fs.readdir(path.join(systemDir, 'tasks')).catch(() => [] as string[])) {
    const id = name.replace(/\.log$/, '');
    tasks.set(id, { id, log: path.join(systemDir, 'tasks', name), finished: false });
  }
  for (const name of await fs.readdir(path.join(systemDir, 'messages')).catch(() => [] as string[])) {
    const file = path.join(systemDir, 'messages', name);
    const notice = await fs
      .readFile(file, 'utf8')
      .then((raw) => JSON.parse(raw) as { sender?: string; renderDetails?: { messageTitle?: string } })
      .catch(() => undefined);
    if (!notice?.sender) continue;
    const id = notice.sender.split('/').pop() ?? notice.sender;
    const existing = tasks.get(id) ?? { id, finished: false };
    // A notice only exists once the job has reported back.
    tasks.set(id, { ...existing, finished: true, title: notice.renderDetails?.messageTitle });
  }
  return [...tasks.values()];
}

async function readUploads(sessionDir: string): Promise<ProviderStats['uploads']> {
  const uploads: ProviderStats['uploads'] = [];
  for (const dir of ['.user_uploaded', '.tempmediaStorage']) {
    const full = path.join(sessionDir, dir);
    for (const name of await fs.readdir(full).catch(() => [] as string[])) {
      if (name.startsWith('.')) continue;
      const stat = await fs.stat(path.join(full, name)).catch(() => undefined);
      uploads.push({ name, path: path.join(full, name), sizeBytes: stat?.size });
    }
  }
  return uploads;
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

/** Every file the agent left in the session directory, not just markdown. */
async function readArtifacts(dir: string): Promise<SessionArtifact[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const artifacts: SessionArtifact[] = [];
  const names = entries.filter((name) => !name.startsWith('.') && !name.endsWith('.metadata.json')).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) continue;
    const kind = artifactKind(name);
    const meta = await fs
      .readFile(`${file}.metadata.json`, 'utf8')
      .then((raw) => JSON.parse(raw) as { summary?: string; updatedAt?: string })
      .catch(() => undefined);
    artifacts.push({
      name,
      path: file,
      kind,
      sizeBytes: stat.size,
      ...(meta?.summary ? { summary: meta.summary } : {}),
      ...(meta?.updatedAt ? { updatedAt: meta.updatedAt } : {}),
      // Binary artifacts are listed, never loaded.
      ...(kind !== 'image' && TEXT_EXT.test(name)
        ? { content: await fs.readFile(file, 'utf8').catch(() => undefined) }
        : {}),
    });
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

    const stats = emptyProviderStats();
    const push = (turn: Omit<TurnEvent, 'id' | 'index'>) => {
      turns.push({ ...turn, index: turns.length, id: `${candidate.id}#${turns.length}` });
    };

    for await (const raw of readJsonl(candidate.path)) {
      const step = raw as Step;
      const timestamp = step.created_at;
      createdAt ??= timestamp;
      const sourceIndex = step.step_index;
      const truncated = (step.truncated_fields?.length ?? 0) > 0;
      if (step.type && !['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC'].includes(step.type)) {
        stats.extras[step.type] = (stats.extras[step.type] ?? 0) + 1;
      }

      if (step.type === 'USER_INPUT' && step.content) {
        const text = stripPromptEnvelope(step.content);
        title ??= oneLine(text, 120);
        push({ kind: 'user', text, timestamp, sourceIndex });
        continue;
      }
      if (step.thinking) push({ kind: 'thinking', text: step.thinking, timestamp, sourceIndex });
      if (step.type === 'PLANNER_RESPONSE' && step.content) {
        push({ kind: 'assistant', text: step.content, timestamp, sourceIndex, truncated });
      }
      for (const call of step.tool_calls ?? []) {
        const args = unwrapArgs(call.args);
        workspace ??= workspaceFromCall(call.name, args);
        push({ kind: 'tool_call', toolName: call.name, toolArgs: args, timestamp, sourceIndex, truncated });
      }
      if (step.type === 'GENERIC' && step.content) {
        push({
          kind: 'tool_result',
          toolResult: step.content,
          isError: /Encountered error|Error:|command failed/i.test(step.content.slice(0, 400)),
          timestamp,
          sourceIndex,
          truncated,
        });
      }
    }

    const dir = path.resolve(path.dirname(candidate.path), '..', '..');
    const systemDir = path.join(dir, '.system_generated');
    const artifacts = await readArtifacts(dir);
    stats.backgroundTasks = await readTasks(systemDir);
    stats.uploads = await readUploads(dir);
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
      stats,
    };
  },
};

/** Antigravity shortens long step output in the transcript; this is the full copy. */
export async function readFullStepOutput(
  transcriptPath: string,
  stepIndex: number,
): Promise<string | undefined> {
  const systemDir = path.resolve(path.dirname(transcriptPath), '..');
  return fs.readFile(path.join(systemDir, 'steps', String(stepIndex), 'output.txt'), 'utf8').catch(() => undefined);
}
