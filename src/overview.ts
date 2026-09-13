import path from 'node:path';
import { clip, oneLine } from './util/text.js';
import { fileWrites, rawCommand, type FileWrite } from './writes.js';
import { summarizeTurns } from './turns.js';
import { classifyUserTurn } from './classify.js';
import { commandLedger, displayPath, errorLedger, fileLedger, jobCounts, jobLedger } from './ledger.js';
import type {
  FileGroup,
  GitCommit,
  TurnSummary,
  NormalizedSession,
  SessionOverview,
  SessionStats,
  TurnEvent,
  TurnKind,
  UserTurnNote,
} from './types.js';

const ABS_PATH = /(?:\/[\w.\-一-鿿]+){2,}/g;
const SSH_HOST = /\b(?:ssh|scp|rsync)\b[^\n;|]*?\b[\w.-]+@((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[\w-]+(?:\.[\w-]+)+))/g;
const NOISE_DIR = /^\/(?:usr|bin|sbin|etc|proc|sys|dev|opt\/homebrew|Library|System)(?:\/|$)/;
const REAL_ROOT = /^\/(?:home|Users|root|var|tmp|private|data|mnt|srv|opt|workspace|app)(?:\/|$)/;
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
const COMMIT_RESULT = /\[([\w./-]+)\s+([0-9a-f]{7,40})\]\s*(.+)/;


function collectAnchors(
  session: NormalizedSession,
  summaries: TurnSummary[],
): SessionOverview['anchors'] {
  interface Seen {
    hits: number;
    firstTurn: number;
    lastTurn: number;
  }
  const dirs = new Map<string, Seen>();
  const files = new Map<string, Seen>();
  const hosts = new Map<string, number>();
  const turnAt = (index: number) =>
    summaries.find((turn) => index >= turn.events[0] && index <= turn.events[1])?.no ?? 1;
  const note = (map: Map<string, Seen>, key: string, turn: number) => {
    const seen = map.get(key);
    if (seen) {
      seen.hits++;
      seen.firstTurn = Math.min(seen.firstTurn, turn);
      seen.lastTurn = Math.max(seen.lastTurn, turn);
    } else {
      map.set(key, { hits: 1, firstTurn: turn, lastTurn: turn });
    }
  };

  for (const turn of session.turns) {
    const body = `${turn.toolArgs ? JSON.stringify(turn.toolArgs) : ''}\n${turn.toolResult ?? ''}`;
    if (!body.trim()) continue;
    const at = turnAt(turn.index);
    const command = rawCommand(turn);
    for (const match of command ? command.matchAll(SSH_HOST) : []) {
      if (match[1]) hosts.set(match[1], (hosts.get(match[1]) ?? 0) + 1);
    }
    for (const match of body.matchAll(ABS_PATH)) {
      const found = match[0];
      if (NOISE_DIR.test(found) || !REAL_ROOT.test(found) || UUID_SEGMENT.test(found)) continue;
      if (/\.\w{1,6}$/.test(found)) {
        note(files, found, at);
        const dir = path.dirname(found);
        if (REAL_ROOT.test(dir)) note(dirs, dir, at);
      } else {
        note(dirs, found, at);
      }
    }
  }

  const top = (map: Map<string, Seen>, kind: 'dir' | 'file') =>
    [...map.entries()]
      .sort((a, b) => b[1].hits - a[1].hits)
      .slice(0, 10)
      .map(([value, seen]) => ({
        path: value,
        hits: seen.hits,
        kind,
        firstTurn: seen.firstTurn,
        lastTurn: seen.lastTurn,
      }));

  return {
    hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([host]) => host),
    paths: [...top(dirs, 'dir'), ...top(files, 'file')],
  };
}

/**
 * A commit shows up twice — in the `git commit -m` call and in the `[branch sha]`
 * the result echoes back. Key on the message so the echo fills in the sha
 * instead of adding a second row for the same commit.
 */
function collectCommits(turns: TurnEvent[]): GitCommit[] {
  const byMessage = new Map<string, GitCommit>();
  const key = (message: string) => message.slice(0, 60);

  for (const turn of turns) {
    const echoed = COMMIT_RESULT.exec(turn.toolResult ?? '');
    if (echoed?.[2] && echoed[3]) {
      const message = oneLine(echoed[3], 120);
      const existing = byMessage.get(key(message));
      if (existing) existing.sha ??= echoed[2];
      else byMessage.set(key(message), { sha: echoed[2], message, timestamp: turn.timestamp });
      continue;
    }
    const command = rawCommand(turn);
    const matched = command ? /git commit[^\n]*?-m\s+(?:'([^']+)'|"([^"]+)")/.exec(command) : undefined;
    const text = matched?.[1] ?? matched?.[2];
    if (!text) continue;
    const message = oneLine(text, 120);
    if (!byMessage.has(key(message))) byMessage.set(key(message), { message, timestamp: turn.timestamp });
  }
  return [...byMessage.values()];
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
  const jobs = jobLedger(session);
  const commands = commandLedger(session);
  const events = { user: 0, assistant: 0, thinking: 0, tool_call: 0, tool_result: 0 } as Record<TurnKind, number>;
  let flaggedErrors = 0;
  for (const turn of session.turns) {
    events[turn.kind]++;
    if (turn.kind === 'tool_result' && turn.isError) flaggedErrors++;
  }

  const provider = session.stats;
  const providerFiles = new Set(provider.fileChanges.map((change) => change.path));
  return {
    turns: turnCount,
    events,
    filesChanged: providerFiles.size || writes.length,
    fileChangeEvents: provider.fileChanges.length || writes.length,
    fileChangeSource: providerFiles.size ? 'provider' : 'inferred',
    commands: commands.length,
    errors: commands.filter((record) => (record.exitCode ?? 0) !== 0).length || flaggedErrors,
    commits: collectCommits(session.turns),
    branches: provider.branches,
    models: provider.models,
    ...(provider.tokens ? { tokens: provider.tokens } : {}),
    artifacts: session.artifacts,
    uploads: provider.uploads,
    jobs,
    jobCounts: jobCounts(jobs),
    extras: provider.extras,
  };
}

/** The last thing of each kind that happened — facts, not a verdict. */
function finalState(session: NormalizedSession, summaries: ReturnType<typeof summarizeTurns>) {
  const commands = commandLedger(session);
  const reversed = [...session.turns].reverse();
  const lastOk = [...commands].reverse().find((record) => record.exitCode === 0);
  const lastFailed = [...commands].reverse().find((record) => (record.exitCode ?? 0) !== 0);
  const files = fileLedger(session);
  return {
    lastUser: reversed.find((event) => event.kind === 'user' && event.text?.trim()),
    lastAssistant: reversed.find((event) => event.kind === 'assistant' && event.text?.trim()),
    lastToolCall: reversed.find((event) => event.kind === 'tool_call'),
    lastOk,
    lastFailed,
    lastFile: files.at(-1),
    unfinishedTurns: summaries.filter((turn) => turn.status !== 'completed'),
  };
}

function formatCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function render(
  overview: Omit<SessionOverview, 'markdown'>,
  session: NormalizedSession,
  summaries: ReturnType<typeof summarizeTurns>,
): string {
  const workspace = session.ref.workspace;
  const { session: ref, stats, goal, corrections, nudges, pastes, anchors, pitfalls } = overview;
  const final = finalState(session, summaries);
  const files = fileLedger(session);
  const byGroup = (group: FileGroup) => files.filter((file) => file.group === group);
  const cmd = (record?: { command: string; exitCode?: number; timestamp?: string }) =>
    record ? `\`exit ${record.exitCode ?? '?'}\` ${oneLine(record.command, 150)}` : '（无）';

  const lines = [
    `# 会话事实 · ${ref.provider}:${ref.id.slice(0, 8)}`,
    '',
    `**${ref.title ?? '（无标题）'}**`,
    '',
    `会话已结束（最后事件 ${ref.updatedAt ?? '?'}）｜ ${stats.jobCounts.unknown} 个作业无完成回执` +
      `｜ ${final.unfinishedTurns.length} 轮未正常收尾`,
    '',
    `- 工作区：${ref.workspace ?? '未知'}　时间：${ref.createdAt ?? '?'} → ${ref.updatedAt ?? '?'}`,
    ...(stats.models.length ? [`- 模型：${stats.models.join(', ')}`] : []),
    ...(stats.branches.length ? [`- 分支：${stats.branches.join(', ')}`] : []),
    ...(anchors.hosts.length ? [`- 远程主机：${anchors.hosts.join(', ')}`] : []),
    '',
    '## 末态（最后发生的事实）',
    '',
    `- 最后一条用户请求：${oneLine(final.lastUser?.text, 150) || '（无）'}`,
    `- 最后一条 assistant：${oneLine(final.lastAssistant?.text, 150) || '（无）'}`,
    `- 最后一次工具调用：#${final.lastToolCall?.index ?? '?'} ${final.lastToolCall?.toolName ?? '（无）'}`,
    `- 最后一条成功命令：${cmd(final.lastOk)}`,
    `- 最后一条失败命令：${cmd(final.lastFailed)}`,
    `- 最后改动的文件：${final.lastFile ? displayPath(final.lastFile, workspace) : '（无）'}`,
    ...(final.unfinishedTurns.length
      ? [`- 未正常收尾的轮次：${final.unfinishedTurns.map((turn) => `T${turn.no}(${turn.status})`).join('、')}`]
      : []),
    '',
    '> 当前主线 / 阻塞 / 下一步属语义层，本阶段不生成。',
    '',
    '## 统计',
    '',
    '| 轮次 | 事件 | 文件 | 命令 | 失败 | 提交 | 产物 | 上传 | 作业 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    `| ${stats.turns} | ${Object.values(stats.events).reduce((a, b) => a + b, 0)} | ` +
      `${stats.filesChanged}（${stats.fileChangeEvents} 次${stats.fileChangeSource === 'inferred' ? '·推断' : ''}） | ` +
      `${stats.commands} | ${stats.errors} | ${stats.commits.length} | ${stats.artifacts.length} | ` +
      `${stats.uploads.length} | ${stats.jobs.length} |`,
    '',
    `事件构成：${Object.entries(stats.events).map(([kind, n]) => `${kind} ${n}`).join(' · ')}` +
      (stats.tokens
        ? `　｜　token：入 ${formatCount(stats.tokens.input)} / 出 ${formatCount(stats.tokens.output)}`
        : ''),
    ...(Object.keys(stats.extras).length
      ? ['', `其他：${Object.entries(stats.extras).map(([k, n]) => `${k} ${n}`).join(' · ')}`]
      : []),
    '',
    '## 目标（最初的用户请求，非当前主线）',
    '',
    goal || '（未能识别）',
    '',
  ];

  if (corrections.length) {
    lines.push(
      '## 指令轨迹',
      '',
      ...corrections.map(
        (note, i) => `- **U${i + 1}** \`${note.timestamp?.slice(11, 19) ?? ''}\` ${note.text}`,
      ),
      '',
      `（另有 ${nudges} 条纯推进指令、${pastes} 条回灌的报告，已折叠）`,
      '',
    );
  }

  lines.push(
    '## 资源',
    '',
    anchors.paths.length
      ? anchors.paths
          .map((anchor) => {
            const tail =
              anchor.lastTurn === summaries.length
                ? 'active'
                : `末见于 T${anchor.lastTurn}，此后未再出现`;
            return `- ${anchor.kind === 'dir' ? '📁' : '📄'} ${anchor.path}　首见 T${anchor.firstTurn} · ${anchor.hits} 次 · ${tail}`;
          })
          .join('\n')
      : '- （无）',
    '',
  );

  if (stats.jobs.length) {
    const counts = stats.jobCounts;
    lines.push(
      `## 异步作业（completed ${counts.completed} · failed ${counts.failed} · running ${counts.running} · unknown ${counts.unknown}）`,
      '',
      ...stats.jobs
        .slice(0, 12)
        .map(
          (job) =>
            `- [${job.status}] ${job.log ?? job.id}${job.pid ? ` pid ${job.pid}` : ''}` +
            `${job.host ? ` @${job.host}` : ''}\n  ${job.evidence.join('；')}`,
        ),
      ...(stats.jobs.length > 12 ? [`- …另有 ${stats.jobs.length - 12} 个，用 1session jobs 查看`] : []),
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

  const project = byGroup('project');
  const runtime = byGroup('runtime');
  const logs = byGroup('log');
  lines.push('## 关键产物', '');
  if (stats.artifacts.length) {
    lines.push(
      '### 会话产物',
      '',
      ...stats.artifacts.map(
        (artifact) =>
          `- [${artifact.kind}] ${artifact.name}${artifact.summary ? `\n  ${oneLine(artifact.summary, 200)}` : ''}`,
      ),
      '',
    );
  }
  lines.push(
    '### 项目文件',
    '',
    project.length ? project.map((file) => `- ${displayPath(file, workspace)}`).join('\n') : '- （无）',
    '',
    '### 运行态文件',
    '',
    runtime.length
      ? runtime.slice(0, 15).map((file) => `- ${displayPath(file, workspace)}`).join('\n') +
        (runtime.length > 15 ? `\n- …另有 ${runtime.length - 15} 个` : '')
      : '- （无）',
    '',
    `### 日志与临时：${logs.length} 个（1session files ${ref.id.slice(0, 8)} --group log 查看）`,
    '',
  );

  const errors = errorLedger(session);
  if (errors.length) {
    lines.push(
      `## 错误（${errors.length} 条，exit_code ≠ 0）`,
      '',
      ...errors
        .slice(0, 12)
        .map(
          (record) =>
            `- \`exit ${record.exitCode ?? '?'}\` ${oneLine(record.command, 120)}` +
            `${record.laterSucceeded ? '　→ 同前缀命令后续成功过' : ''}` +
            `${record.stderr ? `\n  ${oneLine(record.stderr, 150)}` : ''}`,
        ),
      ...(errors.length > 12 ? [`- …另有 ${errors.length - 12} 条，用 1session errors 查看`] : []),
      '',
    );
  } else if (pitfalls.length) {
    lines.push('## 错误', '', ...pitfalls.slice(0, 8).map((pitfall) => `- ${pitfall}`), '');
  }

  return lines.join('\n');
}

/**
 * Tier one of the three-level view: everything about a session that is worth
 * knowing before deciding which turn to open.
 */
export function buildOverview(session: NormalizedSession): SessionOverview {
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

  const summaries = summarizeTurns(session);
  const overview: Omit<SessionOverview, 'markdown'> = {
    session: session.ref,
    stats: buildStats(session, writes, summaries.length),
    goal: clip(userTurns[0]?.text, 1200),
    corrections: notes.filter((note) => note.kind === 'correction'),
    nudges: notes.filter((note) => note.kind === 'nudge').length,
    pastes: notes.filter((note) => note.kind === 'paste').length,
    anchors: collectAnchors(session, summaries),
    writes,
    pitfalls: collectPitfalls(session.turns),
    lastWord: clip(lastAssistant?.text, 800),
  };
  return { ...overview, markdown: render(overview, session, summaries) };
}
