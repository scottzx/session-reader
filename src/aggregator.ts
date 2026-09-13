import path from 'node:path';
import { editedFiles, shellCommand } from './distiller.js';
import { findResolvedByWorkspace, parseSince } from './resolver.js';
import { canonicalizePath, isInside } from './util/paths.js';
import { oneLine } from './util/text.js';
import type {
  AgentProvider,
  DigestFocus,
  FileTouch,
  NormalizedSession,
  SessionRef,
  UnifiedTimelineEntry,
  WorkspaceDigest,
} from './types.js';

export interface AggregateOptions {
  since?: string | Date;
  /** Maximum number of sessions to open and interleave. */
  limit?: number;
  focus?: DigestFocus;
}

const TIMELINE_CAP = 80;

function relativize(file: string, workspace: string): string {
  return isInside(workspace, file) ? path.relative(workspace, file) || '.' : file;
}

/** Keeps the events that tell the story: requests, edits, failures, conclusions. */
function significantEvents(session: NormalizedSession): UnifiedTimelineEntry[] {
  const { provider, id } = session.ref;
  const entries: UnifiedTimelineEntry[] = [];
  const lastAssistant = [...session.turns].reverse().find((t) => t.kind === 'assistant' && t.text?.trim());

  for (const turn of session.turns) {
    const base = { timestamp: turn.timestamp, provider, sessionId: id, kind: turn.kind };
    if (turn.kind === 'user' && turn.text?.trim()) {
      entries.push({ ...base, summary: `提出：${oneLine(turn.text, 180)}` });
      continue;
    }
    const files = editedFiles(turn);
    if (files.length) {
      entries.push({
        ...base,
        summary: `${turn.toolName} → ${files.map((f) => path.basename(f)).join(', ')}`,
      });
      continue;
    }
    if (turn.kind === 'tool_result' && turn.isError) {
      entries.push({ ...base, summary: `失败：${oneLine(turn.toolResult, 140)}` });
      continue;
    }
    if (turn === lastAssistant) {
      entries.push({ ...base, summary: `收束：${oneLine(turn.text, 180)}` });
    }
  }
  return entries;
}

function renderMarkdown(
  digest: Omit<WorkspaceDigest, 'markdown'>,
  focus: DigestFocus,
  stats: Map<string, { turns: number; commands: number; files: number }>,
): string {
  const { workspace, sessions, collaboratingAgents, unifiedTimeline, fileAttribution } = digest;
  const lines: string[] = [
    `# ${path.basename(workspace)} · 跨智能体协作纪实`,
    '',
    `- 工作区：\`${workspace}\``,
    `- 参与智能体：${collaboratingAgents.join(' / ') || '无'}`,
    `- 会话：${sessions.length} 个，统一时间线 ${unifiedTimeline.length} 个节点，涉及 ${Object.keys(fileAttribution).length} 个文件`,
    '',
    '## 会话清单',
    '',
  ];

  for (const ref of sessions) {
    const stat = stats.get(ref.id);
    lines.push(
      `- \`${ref.provider}\` ${ref.id.slice(0, 8)} · ${ref.createdAt ?? '?'} → ${ref.updatedAt ?? '?'}` +
        (stat ? ` · ${stat.turns} 轮 / ${stat.files} 文件 / ${stat.commands} 命令` : '') +
        `\n  ${ref.title ?? '（无标题）'}`,
    );
  }

  lines.push('', '## 统一时间线', '');
  const timeline = unifiedTimeline.slice(0, TIMELINE_CAP);
  for (const entry of timeline) {
    lines.push(`- \`${entry.timestamp ?? '?'}\` **${entry.provider}** ${entry.summary}`);
  }
  if (unifiedTimeline.length > timeline.length) {
    lines.push(`- …另有 ${unifiedTimeline.length - timeline.length} 个节点`);
  }

  if (focus !== 'marketing') {
    lines.push('', '## 文件归属（谁动了什么）', '');
    const files = Object.entries(fileAttribution).sort((a, b) => b[1].length - a[1].length);
    for (const [file, touches] of files.slice(0, 40)) {
      const chain = [...new Set(touches.map((t) => t.provider))].join(' → ');
      lines.push(`- \`${file}\` — ${chain}（${touches.length} 次改动）`);
    }
    if (!files.length) lines.push('- （无文件改动记录）');
    if (files.length > 40) lines.push(`- …另有 ${files.length - 40} 个文件`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Pulls every session that ran in `workspacePath` — regardless of which agent
 * produced it — and interleaves them into a single project storyline.
 */
export async function aggregateWorkspaceSessions(
  workspacePath: string,
  options: AggregateOptions = {},
): Promise<WorkspaceDigest> {
  const workspace = canonicalizePath(workspacePath);
  const limit = options.limit ?? 10;
  const focus = options.focus ?? 'review';

  const resolved = await findResolvedByWorkspace(workspace, { since: options.since, limit });
  // File mtimes only bound the search; the parsed timestamps decide what is in range.
  const sinceMs = parseSince(options.since);
  const sessions: SessionRef[] = [];
  const timeline: UnifiedTimelineEntry[] = [];
  const fileAttribution: Record<string, FileTouch[]> = {};
  const stats = new Map<string, { turns: number; commands: number; files: number }>();

  for (const handle of resolved) {
    const session = await handle.adapter.parse(handle.candidate).catch(() => undefined);
    if (!session) continue;
    if (sinceMs && Date.parse(session.ref.updatedAt ?? '') < sinceMs) continue;

    sessions.push(session.ref);
    timeline.push(...significantEvents(session));

    let commands = 0;
    let files = 0;
    for (const turn of session.turns) {
      if (shellCommand(turn)) commands++;
      for (const file of editedFiles(turn)) {
        files++;
        const key = relativize(file, workspace);
        (fileAttribution[key] ??= []).push({
          provider: session.ref.provider,
          sessionId: session.ref.id,
          timestamp: turn.timestamp,
          toolName: turn.toolName,
        });
      }
    }
    stats.set(session.ref.id, { turns: session.turns.length, commands, files });
  }

  timeline.sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''));
  sessions.sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''));
  const collaboratingAgents = [...new Set(sessions.map((s) => s.provider))] as AgentProvider[];

  const digest: Omit<WorkspaceDigest, 'markdown'> = {
    workspace,
    sessions,
    collaboratingAgents,
    unifiedTimeline: timeline,
    fileAttribution,
  };
  return { ...digest, markdown: renderMarkdown(digest, focus, stats) };
}
