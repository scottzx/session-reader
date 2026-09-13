import path from 'node:path';
import { isInside } from './util/paths.js';
import { clip, oneLine } from './util/text.js';
import { fileWrites, rawCommand, resolveWritePath, type FileWrite } from './writes.js';
import type { NormalizedSession, SessionRef, TurnEvent } from './types.js';

export interface HandoffCorrection {
  timestamp?: string;
  text: string;
}

export interface HandoffAnchor {
  path: string;
  hits: number;
  kind: 'dir' | 'file';
  host?: string;
}

export interface OpenThread {
  timestamp?: string;
  command: string;
  log?: string;
}

export interface HandoffBrief {
  session: SessionRef;
  goal: string;
  corrections: HandoffCorrection[];
  anchors: { hosts: string[]; paths: HandoffAnchor[] };
  writes: FileWrite[];
  openThreads: OpenThread[];
  pitfalls: string[];
  lastWord: string;
  markdown: string;
}

export interface HandoffOptions {
  /** How many path anchors of each kind to keep. */
  anchorLimit?: number;
}

/** Jobs that outlive the session: the receiving agent must know where they land. */
const BACKGROUND = /\b(?:nohup|setsid|start_new_session\s*=\s*True|subprocess\.Popen|Popen\(|queue-[\w-]+\.py)\b/;
const LOG_PATH = /([\w./-]+\.log)\b/;
const ABS_PATH = /(?:\/[\w.\-一-鿿]+){2,}/g;
/** Only ssh/scp/rsync lines name a real host — `@sha256:` digests must not. */
const SSH_HOST = /\b(?:ssh|scp|rsync)\b[^\n;|]*?\b[\w.-]+@((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[\w-]+(?:\.[\w-]+)+))/g;
const NOISE_DIR = /^\/(?:usr|bin|sbin|etc|proc|sys|dev|opt\/homebrew|Library|System)(?:\/|$)/;
/** Anchors must live under a real filesystem root, filtering out API routes. */
const REAL_ROOT = /^\/(?:home|Users|root|var|tmp|private|data|mnt|srv|opt|workspace|app)(?:\/|$)/;
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

function collectAnchors(turns: TurnEvent[], limit: number): { hosts: string[]; paths: HandoffAnchor[] } {
  const dirs = new Map<string, number>();
  const files = new Map<string, number>();
  const hosts = new Map<string, number>();

  for (const turn of turns) {
    const body = `${turn.toolArgs ? JSON.stringify(turn.toolArgs) : ''}\n${turn.toolResult ?? ''}`;
    if (!body.trim()) continue;
    const command = rawCommand(turn);
    for (const match of command ? command.matchAll(SSH_HOST) : []) {
      if (match[1]) hosts.set(match[1], (hosts.get(match[1]) ?? 0) + 1);
    }
    for (const match of body.matchAll(ABS_PATH)) {
      const found = match[0];
      if (NOISE_DIR.test(found) || !REAL_ROOT.test(found) || UUID_SEGMENT.test(found)) continue;
      const isFile = /\.\w{1,6}$/.test(found);
      const bucket = isFile ? files : dirs;
      const key = isFile ? found : found;
      bucket.set(key, (bucket.get(key) ?? 0) + 1);
      if (isFile) {
        const dir = path.dirname(found);
        if (!NOISE_DIR.test(dir)) dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
      }
    }
  }

  const top = (map: Map<string, number>, kind: 'dir' | 'file'): HandoffAnchor[] =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([value, hits]) => ({ path: value, hits, kind }));

  return {
    hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([host]) => host),
    paths: [...top(dirs, 'dir'), ...top(files, 'file')],
  };
}

/** Pulls the one segment that actually launches the job out of a wrapper blob. */
function launchSegment(command: string): string | undefined {
  const segments = command.split(/[\n;]|&&/);
  const launcher = segments.find((segment) => BACKGROUND.test(segment));
  return launcher ? oneLine(launcher, 150) : undefined;
}

function collectOpenThreads(turns: TurnEvent[], limit: number): OpenThread[] {
  const threads: OpenThread[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const command = rawCommand(turn);
    if (!command || !BACKGROUND.test(command)) continue;
    const segment = launchSegment(command);
    if (!segment) continue;
    const log = LOG_PATH.exec(segment)?.[1] ?? LOG_PATH.exec(command)?.[1];
    const key = log ?? segment.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    threads.push({ timestamp: turn.timestamp, command: segment, ...(log ? { log } : {}) });
  }
  // The tail of the session is what may still be running when it ends.
  return threads.slice(-limit);
}

/** Strips the codex `exec` envelope so the actual error text survives. */
function unwrapResult(result: string | undefined): string {
  let text = (result ?? '').replace(/^Script completed\s*Wall time [\d.]+ seconds\s*Output:\s*/i, '');
  // A codex result can bundle several chunks; the longest output is the signal.
  const outputs = [...text.matchAll(/"output"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => match[1] ?? '')
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (outputs[0]) text = outputs[0].replace(/\\n/g, ' ').replace(/\\"/g, '"');
  return text.replace(/^Created At:.*?Completed At:.*?\n/s, '');
}

function collectPitfalls(turns: TurnEvent[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    if (turn.kind !== 'tool_result' || !turn.isError) continue;
    const text = oneLine(unwrapResult(turn.toolResult), 180);
    const key = text.slice(0, 60);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 6) break;
  }
  return out;
}

function render(brief: Omit<HandoffBrief, 'markdown'>, workspace: string | undefined): string {
  const { session, goal, corrections, anchors, writes, openThreads, pitfalls, lastWord } = brief;
  // Certain writes first, then real artifacts ahead of log spew.
  const rank = (write: FileWrite) =>
    (write.confidence === 'explicit' ? 0 : 4) +
    (write.path.startsWith('/') ? 0 : 2) +
    (write.path.endsWith('.log') ? 1 : 0);
  const ordered = [...writes].sort((a, b) => rank(a) - rank(b));
  const local = ordered.filter((write) => !write.host);
  const remote = ordered.filter((write) => write.host);
  const show = (list: FileWrite[], max: number) => {
    const rows = list.slice(0, max).map((write) => {
      const full = resolveWritePath(write, workspace);
      const shown = workspace && isInside(workspace, full) ? path.relative(workspace, full) : full;
      return `- ${shown}${write.confidence === 'inferred' ? ` ~${write.via}` : ''}`;
    });
    if (list.length > max) rows.push(`- …另有 ${list.length - max} 个`);
    return rows.length ? rows.join('\n') : '- （无）';
  };

  const lines = [
    `# 交接简报 · ${session.provider} ${session.id.slice(0, 8)}`,
    '',
    `- 工作区：${session.workspace ?? '未知'}`,
    `- 会话时间：${session.createdAt ?? '?'} → ${session.updatedAt ?? '?'}`,
    ...(anchors.hosts.length ? [`- 远程主机：${anchors.hosts.join(', ')}`] : []),
    '',
    '## 目标',
    '',
    goal || '（未能识别）',
    '',
  ];

  if (corrections.length) {
    lines.push(
      '## 用户的口径修正（务必遵守，按时间顺序）',
      '',
      ...corrections.map((c) => `- ${c.text}`),
      '',
    );
  }

  lines.push(
    '## 状态锚点',
    '',
    anchors.paths.length
      ? anchors.paths.map((a) => `- ${a.kind === 'dir' ? '📁' : '📄'} ${a.path}（${a.hits} 次）`).join('\n')
      : '- （无）',
    '',
    '## 本次落盘',
    '',
    '本地：',
    show(local, 8),
    '',
    '远程：',
    show(remote, 8),
    '',
  );

  if (openThreads.length) {
    lines.push(
      '## 未完成的后台任务（会话结束后仍在跑，去这里看结果）',
      '',
      ...openThreads.map((t) => `- ${t.log ? `\`${t.log}\` ← ` : ''}${t.command}`),
      '',
      '（取会话尾部最近 8 个；更早的可能早已跑完）',
      '',
    );
  }
  if (pitfalls.length) {
    lines.push('## 已经踩过的坑（别重复）', '', ...pitfalls.map((p) => `- ${p}`), '');
  }

  lines.push('## 上游最后的话', '', lastWord || '（无）', '');
  return lines.join('\n');
}

/**
 * Compresses a session into the state another agent needs to take over:
 * what was asked, how the user corrected course, which objects are in play,
 * what was written, and what is still running.
 */
export function buildHandoff(session: NormalizedSession, options: HandoffOptions = {}): HandoffBrief {
  const anchorLimit = options.anchorLimit ?? 6;
  const workspace = session.ref.workspace;

  const userTurns = session.turns.filter((turn) => turn.kind === 'user' && turn.text?.trim());
  const writes = new Map<string, FileWrite>();
  for (const turn of session.turns) {
    for (const write of fileWrites(turn)) {
      const key = `${write.host ?? ''}|${write.path}`;
      if (!writes.has(key)) writes.set(key, write);
    }
  }
  const lastAssistant = [...session.turns].reverse().find((t) => t.kind === 'assistant' && t.text?.trim());

  const brief: Omit<HandoffBrief, 'markdown'> = {
    session: session.ref,
    goal: clip(userTurns[0]?.text, 600),
    corrections: userTurns.slice(1).map((turn) => ({
      timestamp: turn.timestamp,
      text: oneLine(turn.text, 150),
    })),
    anchors: collectAnchors(session.turns, anchorLimit),
    writes: [...writes.values()],
    openThreads: collectOpenThreads(session.turns, 8),
    pitfalls: collectPitfalls(session.turns),
    lastWord: clip(lastAssistant?.text, 500),
  };
  return { ...brief, markdown: render(brief, workspace) };
}
