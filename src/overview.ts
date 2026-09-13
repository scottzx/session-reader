import path from 'node:path';
import { isInside } from './util/paths.js';
import { clip, oneLine } from './util/text.js';
import { fileWrites, rawCommand, resolveWritePath, type FileWrite } from './writes.js';
import { summarizeTurns } from './turns.js';
import type {
  GitCommit,
  NormalizedSession,
  SessionOverview,
  SessionStats,
  TurnEvent,
  TurnKind,
  UserTurnKind,
  UserTurnNote,
} from './types.js';

const ABS_PATH = /(?:\/[\w.\-一-鿿]+){2,}/g;
const SSH_HOST = /\b(?:ssh|scp|rsync)\b[^\n;|]*?\b[\w.-]+@((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[\w-]+(?:\.[\w-]+)+))/g;
const NOISE_DIR = /^\/(?:usr|bin|sbin|etc|proc|sys|dev|opt\/homebrew|Library|System)(?:\/|$)/;
const REAL_ROOT = /^\/(?:home|Users|root|var|tmp|private|data|mnt|srv|opt|workspace|app)(?:\/|$)/;
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
/** Pure "keep going" replies carry no instruction worth handing on. */
const NUDGE = /^(?:继续|再继续|contin|continue|go on|好的?|ok|okay|嗯+|再来|下一步|next|yes|是的|可以)[。.!！~]*$/i;
const COMMIT_RESULT = /\[([\w./-]+)\s+([0-9a-f]{7,40})\]\s*(.+)/;

export function classifyUserTurn(text: string): UserTurnKind {
  const value = text.trim();
  if (NUDGE.test(value)) return 'nudge';
  // Long markdown reports are the user pasting an agent's own output back in.
  if (value.length > 300 && (/(^|\n)#{1,4}\s/.test(value) || /🎉|阶段性|全面完成/.test(value))) return 'paste';
  return 'correction';
}

function collectAnchors(turns: TurnEvent[]): SessionOverview['anchors'] {
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
      if (/\.\w{1,6}$/.test(found)) {
        files.set(found, (files.get(found) ?? 0) + 1);
        const dir = path.dirname(found);
        if (REAL_ROOT.test(dir)) dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
      } else {
        dirs.set(found, (dirs.get(found) ?? 0) + 1);
      }
    }
  }

  const top = (map: Map<string, number>, kind: 'dir' | 'file') =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([value, hits]) => ({ path: value, hits, kind }));

  return {
    hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([host]) => host),
    paths: [...top(dirs, 'dir'), ...top(files, 'file')],
  };
}

/** Commits are announced by the command that made them and echoed by its result. */
function collectCommits(turns: TurnEvent[]): GitCommit[] {
  const commits: GitCommit[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const echoed = COMMIT_RESULT.exec(turn.toolResult ?? '');
    if (echoed?.[2]) {
      if (seen.has(echoed[2])) continue;
      seen.add(echoed[2]);
      commits.push({ sha: echoed[2], message: oneLine(echoed[3], 120), timestamp: turn.timestamp });
      continue;
    }
    const command = rawCommand(turn);
    const message = command ? /git commit[^\n]*?-m\s+(?:'([^']+)'|"([^"]+)")/.exec(command) : undefined;
    const text = message?.[1] ?? message?.[2];
    if (text && !seen.has(text)) {
      seen.add(text);
      commits.push({ message: oneLine(text, 120), timestamp: turn.timestamp });
    }
  }
  return commits;
}

/** Strips the codex `exec` envelope so the actual error text survives. */
function unwrapResult(result: string | undefined): string {
  let text = (result ?? '').replace(/^Script completed\s*Wall time [\d.]+ seconds\s*Output:\s*/i, '');
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
    const text = oneLine(unwrapResult(turn.toolResult), 200);
    const key = text.slice(0, 60);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function buildStats(session: NormalizedSession, writes: FileWrite[], turnCount: number): SessionStats {
  const events = { user: 0, assistant: 0, thinking: 0, tool_call: 0, tool_result: 0 } as Record<TurnKind, number>;
  let commands = 0;
  let errors = 0;
  for (const turn of session.turns) {
    events[turn.kind]++;
    if (rawCommand(turn)) commands++;
    if (turn.kind === 'tool_result' && turn.isError) errors++;
  }

  const provider = session.stats;
  const providerFiles = new Set(provider.fileChanges.map((change) => change.path));
  return {
    turns: turnCount,
    events,
    filesChanged: providerFiles.size || writes.length,
    fileChangeEvents: provider.fileChanges.length || writes.length,
    fileChangeSource: providerFiles.size ? 'provider' : 'inferred',
    commands: provider.commandExecutions ?? commands,
    errors,
    commits: collectCommits(session.turns),
    branches: provider.branches,
    models: provider.models,
    ...(provider.tokens ? { tokens: provider.tokens } : {}),
    artifacts: session.artifacts,
    uploads: provider.uploads,
    backgroundTasks: provider.backgroundTasks,
    extras: provider.extras,
  };
}

function formatCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function render(overview: Omit<SessionOverview, 'markdown'>, workspace: string | undefined): string {
  const { session, stats, goal, corrections, nudges, pastes, anchors, writes, pitfalls, lastWord } = overview;
  const label = (write: FileWrite) => {
    const full = resolveWritePath(write, workspace);
    const shown = workspace && isInside(workspace, full) ? path.relative(workspace, full) : full;
    return `${shown}${write.confidence === 'inferred' ? ` ~${write.via}` : ''}`;
  };

  const lines = [
    `# 会话概要 · ${session.provider} ${session.id.slice(0, 8)}`,
    '',
    `**${session.title ?? '（无标题）'}**`,
    '',
    `- 工作区：${session.workspace ?? '未知'}`,
    `- 时间：${session.createdAt ?? '?'} → ${session.updatedAt ?? '?'}`,
    ...(stats.models.length ? [`- 模型：${stats.models.join(', ')}`] : []),
    ...(stats.branches.length ? [`- 分支：${stats.branches.join(', ')}`] : []),
    ...(anchors.hosts.length ? [`- 远程主机：${anchors.hosts.join(', ')}`] : []),
    '',
    '## 统计',
    '',
    `| 轮次 | 事件 | 文件改动 | 命令 | 失败 | 提交 | 产物 | 上传 | 后台任务 |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    `| ${stats.turns} | ${Object.values(stats.events).reduce((a, b) => a + b, 0)} | ` +
      `${stats.filesChanged}（${stats.fileChangeEvents} 次${stats.fileChangeSource === 'inferred' ? '·推断' : ''}） | ${stats.commands} | ` +
      `${stats.errors} | ${stats.commits.length} | ${stats.artifacts.length} | ${stats.uploads.length} | ` +
      `${stats.backgroundTasks.filter((task) => task.finished).length}/${stats.backgroundTasks.length} 完成 |`,
    '',
    `事件构成：${Object.entries(stats.events).map(([kind, n]) => `${kind} ${n}`).join(' · ')}` +
      (stats.tokens
        ? `　｜　token：入 ${formatCount(stats.tokens.input)} / 出 ${formatCount(stats.tokens.output)}`
        : ''),
    ...(Object.keys(stats.extras).length
      ? ['', `其他：${Object.entries(stats.extras).map(([k, n]) => `${k} ${n}`).join(' · ')}`]
      : []),
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
      ...corrections.map((note) => `- \`${note.timestamp?.slice(11, 19) ?? ''}\` ${note.text}`),
      '',
      `（另有 ${nudges} 条纯推进指令、${pastes} 条回灌的报告，已折叠）`,
      '',
    );
  }

  if (stats.commits.length) {
    lines.push(
      '## Git 提交',
      '',
      ...stats.commits.map((commit) => `- ${commit.sha ? `\`${commit.sha.slice(0, 7)}\` ` : ''}${commit.message}`),
      '',
    );
  }

  if (stats.artifacts.length) {
    lines.push(
      '## 产物',
      '',
      ...stats.artifacts.map(
        (artifact) =>
          `- [${artifact.kind}] ${artifact.name}${artifact.summary ? `\n  ${oneLine(artifact.summary, 200)}` : ''}`,
      ),
      '',
    );
  }

  if (stats.backgroundTasks.length) {
    const pending = stats.backgroundTasks.filter((task) => !task.finished);
    lines.push(
      '## 后台任务',
      '',
      ...stats.backgroundTasks.map(
        (task) => `- ${task.finished ? '✔' : '…'} ${task.id}${task.title ? ` — ${task.title}` : ''}`,
      ),
      ...(pending.length ? ['', `⚠️ ${pending.length} 个未见完成回执，可能仍在跑`] : []),
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
    '## 落盘（全量）',
    '',
    writes.length ? writes.map((write) => `- ${label(write)}`).join('\n') : '- （无）',
    '',
  );

  if (pitfalls.length) {
    lines.push('## 踩过的坑', '', ...pitfalls.map((pitfall) => `- ${pitfall}`), '');
  }
  lines.push('## 最后的话', '', lastWord || '（无）', '');
  return lines.join('\n');
}

/**
 * Tier one of the three-level view: everything about a session that is worth
 * knowing before deciding which turn to open.
 */
export function buildOverview(session: NormalizedSession): SessionOverview {
  const workspace = session.ref.workspace;
  const writeMap = new Map<string, FileWrite>();
  for (const turn of session.turns) {
    for (const write of fileWrites(turn)) {
      const key = `${write.host ?? ''}|${write.path}`;
      if (!writeMap.has(key)) writeMap.set(key, write);
    }
  }
  for (const change of session.stats.fileChanges) {
    const key = `|${change.path}`;
    if (!writeMap.has(key)) writeMap.set(key, { path: change.path, confidence: 'explicit', via: change.change });
  }

  const userTurns = session.turns.filter((turn) => turn.kind === 'user' && turn.text?.trim());
  const notes: UserTurnNote[] = userTurns.slice(1).map((turn) => ({
    timestamp: turn.timestamp,
    kind: classifyUserTurn(turn.text!),
    text: oneLine(turn.text, 400),
  }));
  const lastAssistant = [...session.turns].reverse().find((turn) => turn.kind === 'assistant' && turn.text?.trim());
  const writes = [...writeMap.values()];

  const overview: Omit<SessionOverview, 'markdown'> = {
    session: session.ref,
    stats: buildStats(session, writes, summarizeTurns(session).length),
    goal: clip(userTurns[0]?.text, 1200),
    corrections: notes.filter((note) => note.kind === 'correction'),
    nudges: notes.filter((note) => note.kind === 'nudge').length,
    pastes: notes.filter((note) => note.kind === 'paste').length,
    anchors: collectAnchors(session.turns),
    writes,
    pitfalls: collectPitfalls(session.turns),
    lastWord: clip(lastAssistant?.text, 800),
  };
  return { ...overview, markdown: render(overview, workspace) };
}
