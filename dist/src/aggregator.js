import path from 'node:path';
import { shellCommand } from './distiller.js';
import { fileWrites, resolveWritePath } from './writes.js';
import { findResolvedByWorkspace, parseSince } from './resolver.js';
import { canonicalizePath, isInside } from './util/paths.js';
import { oneLine } from './util/text.js';
const TIMELINE_CAP = 80;
function relativize(file, workspace) {
    return isInside(workspace, file) ? path.relative(workspace, file) || '.' : file;
}
/** Keeps the events that tell the story: requests, edits, failures, conclusions. */
function significantEvents(session) {
    const { provider, id } = session.ref;
    const entries = [];
    const lastAssistant = [...session.turns].reverse().find((t) => t.kind === 'assistant' && t.text?.trim());
    for (const turn of session.turns) {
        const base = { timestamp: turn.timestamp, provider, sessionId: id, kind: turn.kind };
        if (turn.kind === 'user' && turn.text?.trim()) {
            entries.push({ ...base, summary: `提出：${oneLine(turn.text, 180)}` });
            continue;
        }
        const writes = fileWrites(turn);
        if (writes.length) {
            entries.push({
                ...base,
                summary: `${turn.toolName} → ${writes.map((w) => path.basename(w.path)).join(', ')}`,
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
function renderMarkdown(digest, focus, stats) {
    const { workspace, sessions, collaboratingAgents, unifiedTimeline, fileAttribution } = digest;
    const lines = [
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
        lines.push(`- \`${ref.provider}\` ${ref.id.slice(0, 8)} · ${ref.createdAt ?? '?'} → ${ref.updatedAt ?? '?'}` +
            (stat ? ` · ${stat.turns} 轮 / ${stat.files} 文件 / ${stat.commands} 命令` : '') +
            `\n  ${ref.title ?? '（无标题）'}`);
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
            const inferred = touches.every((t) => t.provenance === 'derived') ? ' ~推断' : '';
            lines.push(`- \`${file}\` — ${chain}（${touches.length} 次改动${inferred}）`);
        }
        if (!files.length)
            lines.push('- （无文件改动记录）');
        if (files.length > 40)
            lines.push(`- …另有 ${files.length - 40} 个文件`);
    }
    lines.push('');
    return lines.join('\n');
}
/**
 * Pulls every session that ran in `workspacePath` — regardless of which agent
 * produced it — and interleaves them into a single project storyline.
 */
export async function aggregateWorkspaceSessions(workspacePath, options = {}) {
    const workspace = canonicalizePath(workspacePath);
    const limit = options.limit ?? 10;
    const focus = options.focus ?? 'review';
    const resolved = await findResolvedByWorkspace(workspace, { since: options.since, limit });
    // File mtimes only bound the search; the parsed timestamps decide what is in range.
    const sinceMs = parseSince(options.since);
    const sessions = [];
    const timeline = [];
    const fileAttribution = {};
    const stats = new Map();
    for (const handle of resolved) {
        const session = await handle.adapter.parse(handle.candidate).catch(() => undefined);
        if (!session)
            continue;
        if (sinceMs && Date.parse(session.ref.updatedAt ?? '') < sinceMs)
            continue;
        sessions.push(session.ref);
        timeline.push(...significantEvents(session));
        let commands = 0;
        let files = 0;
        for (const turn of session.turns) {
            if (shellCommand(turn))
                commands++;
            for (const write of fileWrites(turn)) {
                files++;
                const key = relativize(resolveWritePath(write, session.ref.workspace), workspace);
                (fileAttribution[key] ??= []).push({
                    provider: session.ref.provider,
                    sessionId: session.ref.id,
                    timestamp: turn.timestamp,
                    toolName: turn.toolName,
                    provenance: write.provenance,
                    ...(write.host ? { host: write.host } : {}),
                });
            }
        }
        stats.set(session.ref.id, { turns: session.turns.length, commands, files });
    }
    timeline.sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''));
    sessions.sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''));
    const collaboratingAgents = [...new Set(sessions.map((s) => s.provider))];
    const digest = {
        workspace,
        sessions,
        collaboratingAgents,
        unifiedTimeline: timeline,
        fileAttribution,
    };
    return { ...digest, markdown: renderMarkdown(digest, focus, stats) };
}
