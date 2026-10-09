import { auxiliaryFingerprint } from '../util/fingerprint.js';
import { sourceEvents, existingTitles } from './source.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.js';
import { canonicalizePath } from '../util/paths.js';
import { clip, looksLikeInstructions, oneLine, stripPromptEnvelope } from '../util/text.js';
import { toolArgsOf } from './provider.js';
import { emptyProviderStats, } from '../types.js';
/**
 * Grok keeps one directory per session, filed under the percent-encoded cwd:
 * `sessions/%2FUsers%2Fme%2Fproj/<uuid>/`. The conversation of record is
 * `chat_history.jsonl`, which carries no timestamps at all — those live in the
 * side files next to it, so this parser reads the directory, not one file.
 */
const SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');
const TRANSCRIPT = 'chat_history.jsonl';
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** `<system-reminder>` receipts Grok injects as user messages. */
const TASK_RECEIPT = /Background task "([^"]+)"/;
const SUBAGENT_RECEIPT = /Background subagent "([^"]+)"/;
const RECEIPT_COMMAND = /^Command:\s*(.+)$/m;
/** Grok wraps the real prompt; the envelope around it is boilerplate. */
const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/;
/**
 * Matches a message to the moment it was streamed by its own text — an
 * identity, not an alignment, so it survives the two files disagreeing about
 * how many messages there were. Repeats are handed out in stream order.
 */
function clockByText(chunks) {
    const byText = new Map();
    for (const chunk of chunks) {
        const times = byText.get(chunk.text);
        if (times)
            times.push(chunk.at);
        else
            byText.set(chunk.text, [chunk.at]);
    }
    return (text) => byText.get(text)?.shift();
}
function textOf(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .map((block) => block?.text ?? '')
        .filter(Boolean)
        .join('\n');
}
function parseArguments(value) {
    if (typeof value === 'string') {
        try {
            return toolArgsOf(JSON.parse(value)) ?? { input: value };
        }
        catch {
            return { input: value };
        }
    }
    return toolArgsOf(value);
}
/**
 * The side files come and go — a subagent session has no `rewind_points.jsonl`,
 * an older one no `updates.jsonl`. A missing file is an absence of facts, not a
 * reason to fail the session that the transcript itself describes fine.
 */
async function* optionalJsonl(file) {
    if (!(await fs.stat(file).then((stat) => stat.isFile()).catch(() => false)))
        return;
    yield* readJsonl(file);
}
async function readJson(file) {
    return fs
        .readFile(file, 'utf8')
        .then((raw) => JSON.parse(raw))
        .catch(() => undefined);
}
/**
 * `tool_started` carries no id and `tool_completed` carries no start, so the
 * two streams are zipped by position — and only when they line up exactly.
 * A mismatch means the session was cut mid-call; ids still give the ends.
 */
async function readTimings(sessionDir, stats) {
    const timings = new Map();
    const started = [];
    const completed = [];
    for await (const raw of optionalJsonl(path.join(sessionDir, 'events.jsonl'))) {
        const event = raw;
        switch (event.type) {
            case 'tool_started':
                if (event.ts)
                    started.push(event.ts);
                break;
            case 'tool_completed':
                completed.push({
                    ...(event.tool_call_id ? { id: event.tool_call_id } : {}),
                    ...(event.ts ? { ts: event.ts } : {}),
                    ...(typeof event.duration_ms === 'number' ? { durationMs: event.duration_ms } : {}),
                    failed: event.outcome !== undefined && event.outcome !== 'success',
                });
                break;
            case 'turn_started':
                stats.turnBoundaries.push({
                    id: String(raw.turn_number ?? stats.turnBoundaries.length),
                    ...(event.ts ? { startedAt: event.ts } : {}),
                    completed: false,
                });
                break;
            case 'turn_ended': {
                // Only ever one turn open at a time, so the oldest unfinished one is it.
                // A turn that ended badly still ended: the boundary is paired either
                // way, and *how* it ended is a separate fact kept in `extras`.
                const open = stats.turnBoundaries.find((boundary) => !boundary.completed);
                if (open) {
                    open.completed = true;
                    if (event.ts)
                        open.endedAt = event.ts;
                    if (open.startedAt && event.ts) {
                        open.durationMs = Math.max(0, Date.parse(event.ts) - Date.parse(open.startedAt));
                    }
                }
                if (event.outcome && event.outcome !== 'completed') {
                    stats.extras[`turn:${event.outcome}`] = (stats.extras[`turn:${event.outcome}`] ?? 0) + 1;
                }
                break;
            }
            case 'mcp_server_connected':
                stats.extras.mcpServers = (stats.extras.mcpServers ?? 0) + 1;
                break;
            default:
                break;
        }
    }
    const zipped = started.length === completed.length;
    completed.forEach((record, i) => {
        if (!record.id)
            return;
        timings.set(record.id, {
            ...(zipped && started[i] ? { startedAt: started[i] } : {}),
            ...(record.ts ? { endedAt: record.ts } : {}),
            ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
            ...(record.failed ? { failed: true } : {}),
        });
    });
    return timings;
}
/** `prompt_index` → the moment Grok recorded for that prompt. */
async function readPromptTimes(sessionDir) {
    const times = new Map();
    for await (const raw of optionalJsonl(path.join(sessionDir, 'rewind_points.jsonl'))) {
        const point = raw;
        if (typeof point.prompt_index === 'number' && point.created_at) {
            times.set(point.prompt_index, point.created_at);
        }
    }
    return times;
}
/**
 * The ACP stream Grok mirrors every session to — present for most sessions but
 * not all, so everything it gives is an enrichment, never a prerequisite.
 */
async function readUpdates(sessionDir) {
    const file = path.join(sessionDir, 'updates.jsonl');
    if (!(await fs.stat(file).then(() => true).catch(() => false)))
        return undefined;
    const timing = { user: [], thought: [], message: [], byCall: new Map(), plans: 0 };
    const tokens = { input: 0, output: 0, total: 0 };
    let cacheRead = 0;
    for await (const raw of readJsonl(file)) {
        const line = raw;
        const update = line.params?.update;
        if (!update)
            continue;
        // Seconds since the epoch, unlike every other file in the directory.
        const at = typeof line.timestamp === 'number' ? new Date(line.timestamp * 1000).toISOString() : undefined;
        const callId = update.toolCallId;
        switch (update.sessionUpdate) {
            case 'user_message_chunk':
                if (at)
                    timing.user.push(at);
                break;
            case 'agent_thought_chunk':
            case 'agent_message_chunk': {
                const text = update.content?.text;
                if (!at || !text)
                    break;
                const into = update.sessionUpdate === 'agent_thought_chunk' ? timing.thought : timing.message;
                into.push({ text, at });
                break;
            }
            case 'tool_call':
                if (callId && at)
                    timing.byCall.set(callId, { ...(timing.byCall.get(callId) ?? {}), calledAt: at });
                break;
            case 'tool_call_update':
                if (callId && at && update.status === 'completed') {
                    timing.byCall.set(callId, { ...(timing.byCall.get(callId) ?? {}), endedAt: at });
                }
                break;
            case 'plan':
                timing.plans++;
                break;
            case 'turn_completed': {
                const usage = update.usage;
                if (usage) {
                    // Grok counts cache reads *inside* `inputTokens`; reporting them as
                    // input would turn a 200k-context session into "39M tokens".
                    const cached = usage.cachedReadTokens ?? 0;
                    tokens.input += Math.max(0, (usage.inputTokens ?? 0) - cached);
                    tokens.output += usage.outputTokens ?? 0;
                    cacheRead += cached;
                }
                break;
            }
            default:
                break;
        }
    }
    if (tokens.input || tokens.output) {
        timing.tokens = {
            ...tokens,
            total: tokens.input + tokens.output,
            ...(cacheRead ? { cacheRead } : {}),
        };
    }
    return timing;
}
/** Plans and walkthroughs Grok's goal tracker writes next to the transcript. */
async function readArtifacts(sessionDir) {
    const dir = path.join(sessionDir, 'goal');
    const artifacts = [];
    for (const name of await fs.readdir(dir).catch(() => [])) {
        if (!name.endsWith('.md'))
            continue;
        const full = path.join(dir, name);
        const stat = await fs.stat(full).catch(() => undefined);
        if (!stat?.isFile())
            continue;
        const content = await fs.readFile(full, 'utf8').catch(() => undefined);
        artifacts.push({
            name,
            path: full,
            kind: 'markdown',
            ...(content ? { content, summary: oneLine(content.split('\n').find((line) => line.trim()), 120) } : {}),
            sizeBytes: stat.size,
            updatedAt: new Date(stat.mtimeMs).toISOString(),
        });
    }
    return artifacts;
}
/**
 * A receipt Grok injects when a background task or subagent reports back. Its
 * presence is the completion proof `jobLedger` otherwise has to do without.
 */
function receiptOf(text, logDir) {
    const task = TASK_RECEIPT.exec(text);
    const id = task?.[1] ?? SUBAGENT_RECEIPT.exec(text)?.[1];
    if (!id)
        return undefined;
    // The command for a task, the agent descriptor for a subagent.
    const title = RECEIPT_COMMAND.exec(text)?.[1] ?? text.split('\n').find((line) => line.includes(id));
    return {
        id,
        ...(title ? { title: clip(title.trim(), 120) } : {}),
        ...(task ? { log: path.join(logDir, `${id}.log`) } : {}),
        finished: true,
    };
}
/** `sessions/<percent-encoded cwd>/<uuid>/`, one entry per session. */
async function sessionDirs() {
    let projects;
    try {
        projects = await fs.readdir(SESSIONS_DIR);
    }
    catch {
        return [];
    }
    const found = [];
    for (const project of projects) {
        // Everything Grok files here starts with the encoded leading `/`; the
        // loose `session_search.sqlite` and the dotfiles beside it do not.
        if (!project.startsWith('%2F'))
            continue;
        for (const entry of await fs.readdir(path.join(SESSIONS_DIR, project)).catch(() => [])) {
            if (!SESSION_ID.test(entry))
                continue;
            found.push({ id: entry, dir: path.join(SESSIONS_DIR, project, entry) });
        }
    }
    return found;
}
/**
 * The directory name is the percent-encoded cwd, so it decodes back exactly —
 * unlike Claude's lossy slug, this is an answer rather than a prefilter.
 */
export function workspaceFromProjectDir(name) {
    try {
        return canonicalizePath(decodeURIComponent(name));
    }
    catch {
        return '';
    }
}
export const grokAdapter = {
    provider: 'grok',
    async listCandidates() {
        const found = [];
        for (const { id, dir } of await sessionDirs()) {
            const transcript = path.join(dir, TRANSCRIPT);
            const stat = await fs.stat(transcript).catch(() => undefined);
            // A directory holding nothing but `summary.json` is a session that never
            // produced a transcript; there is nothing to read.
            if (!stat?.isFile())
                continue;
            // `summary.json` is rewritten on every update, so the newer of the two
            // mtimes is what "when did this session last move" actually means.
            const summary = await fs.stat(path.join(dir, 'summary.json')).catch(() => undefined);
            found.push({
                id,
                path: transcript,
                mtimeMs: Math.max(stat.mtimeMs, summary?.mtimeMs ?? 0),
                sizeBytes: stat.size,
            });
        }
        return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    },
    workspaceOf(candidate) {
        return workspaceFromProjectDir(path.basename(path.dirname(path.dirname(candidate.path)))) || undefined;
    },
    /** The side files change without the transcript growing; fold them in. */
    async auxFingerprint(candidate) {
        const dir = path.dirname(candidate.path);
        const names = await fs.readdir(dir).catch(() => []);
        return auxiliaryFingerprint(names.filter((name) => name !== TRANSCRIPT && name !== 'terminal').map((name) => path.join(dir, name)));
    },
    async scanRef(candidate) {
        const dir = path.dirname(candidate.path);
        const summary = await readJson(path.join(dir, 'summary.json'));
        let title = summary?.generated_title || summary?.session_summary || undefined;
        const workspace = summary?.info?.cwd
            ? canonicalizePath(summary.info.cwd)
            : workspaceFromProjectDir(path.basename(path.dirname(dir)));
        if (!title) {
            for await (const raw of readJsonl(candidate.path, { maxLines: 40 })) {
                const line = raw;
                if (line.type !== 'user' || line.synthetic_reason)
                    continue;
                const text = stripPromptEnvelope(textOf(line.content));
                if (text && !looksLikeInstructions(text)) {
                    title = oneLine(text, 120);
                    break;
                }
            }
        }
        return {
            id: candidate.id,
            provider: 'grok',
            path: candidate.path,
            ...(title ? { title } : {}),
            ...(workspace ? { workspace } : {}),
            ...(summary?.created_at ? { createdAt: summary.created_at } : {}),
            updatedAt: summary?.updated_at ?? summary?.last_active_at ?? new Date(candidate.mtimeMs).toISOString(),
            sizeBytes: candidate.sizeBytes,
        };
    },
    async parse(candidate) {
        const dir = path.dirname(candidate.path);
        const stats = emptyProviderStats();
        const turns = [];
        const sources = sourceEvents('grok', candidate.id);
        const summary = await readJson(path.join(dir, 'summary.json'));
        const signals = await readJson(path.join(dir, 'signals.json'));
        const timings = await readTimings(dir, stats);
        const promptTimes = await readPromptTimes(dir);
        const updates = await readUpdates(dir);
        const artifacts = await readArtifacts(dir);
        const logDir = path.join(dir, 'terminal');
        if (summary?.current_model_id)
            stats.models.push(summary.current_model_id);
        if (summary?.head_branch)
            stats.branches.push(summary.head_branch);
        if (summary?.session_kind && summary.session_kind !== 'primary') {
            stats.extras[`session:${summary.session_kind}`] = 1;
        }
        if (signals?.compactionCount)
            stats.extras.compactions = signals.compactionCount;
        if (updates?.plans)
            stats.extras.plans = updates.plans;
        if (updates?.tokens)
            stats.tokens = updates.tokens;
        // Messages carry no id in either file, so a message is matched to its
        // streamed moment by its own text. The transcript sometimes concatenates
        // what the stream sent in pieces, so whatever is left over falls back to
        // position — and only when the two counts agree, because a shifted
        // timestamp is worse than a missing one.
        const positions = {
            user: [],
            thought: [],
            message: [],
        };
        const thoughtAt = clockByText(updates?.thought ?? []);
        const messageAt = clockByText(updates?.message ?? []);
        let title = summary?.generated_title || summary?.session_summary || undefined;
        let firstPrompt;
        // An explicit `timestamp: undefined` is not the same object as one without
        // the key, and the index stores absent columns as absent — so a session read
        // back from it would stop deep-equalling a fresh parse.
        const push = ({ timestamp, ...turn }) => {
            turns.push({
                ...sources.event(turn),
                ...(timestamp ? { timestamp } : {}),
                index: turns.length,
                id: `${candidate.id}#${turns.length}`,
            });
        };
        for await (const raw of readJsonl(candidate.path)) {
            const line = raw;
            sources.record(raw);
            switch (line.type) {
                case 'user': {
                    const rawText = textOf(line.content);
                    if (line.synthetic_reason) {
                        // Receipts are the only synthetic messages carrying new facts;
                        // the rest is boilerplate the harness re-injects every turn.
                        const receipt = receiptOf(rawText, logDir);
                        if (!receipt) {
                            const key = `injected:${line.synthetic_reason}`;
                            stats.extras[key] = (stats.extras[key] ?? 0) + 1;
                            break;
                        }
                        if (!stats.backgroundTasks.some((task) => task.id === receipt.id)) {
                            stats.backgroundTasks.push(receipt);
                        }
                        push({
                            kind: 'tool_result',
                            toolResult: rawText.replace(/<\/?system-reminder>/g, '').trim(),
                            timestamp: promptTimes.get(line.prompt_index ?? -1),
                        });
                        break;
                    }
                    const query = USER_QUERY.exec(rawText)?.[1] ?? rawText;
                    const text = stripPromptEnvelope(query);
                    if (!text || looksLikeInstructions(text))
                        break;
                    firstPrompt ??= oneLine(text, 120);
                    positions.user.push(turns.length);
                    push({ kind: 'user', text, timestamp: promptTimes.get(line.prompt_index ?? -1) });
                    break;
                }
                case 'reasoning': {
                    const text = (line.summary ?? []).map((block) => block?.text ?? '').filter(Boolean).join('\n');
                    if (!text)
                        break;
                    positions.thought.push(turns.length);
                    push({ kind: 'thinking', text, timestamp: thoughtAt(text) });
                    break;
                }
                case 'assistant': {
                    if (line.model_id && !stats.models.includes(line.model_id))
                        stats.models.push(line.model_id);
                    const text = typeof line.content === 'string' ? line.content : textOf(line.content);
                    if (text.trim()) {
                        positions.message.push(turns.length);
                        push({ kind: 'assistant', text, timestamp: messageAt(text) });
                    }
                    for (const call of line.tool_calls ?? []) {
                        const timing = call.id ? timings.get(call.id) : undefined;
                        const stream = call.id ? updates?.byCall.get(call.id) : undefined;
                        push({
                            kind: 'tool_call',
                            ...(call.id ? { callId: call.id } : {}),
                            toolName: call.name,
                            toolArgs: parseArguments(call.arguments),
                            timestamp: timing?.startedAt ?? stream?.calledAt,
                        });
                    }
                    break;
                }
                case 'tool_result': {
                    const timing = line.tool_call_id ? timings.get(line.tool_call_id) : undefined;
                    const stream = line.tool_call_id ? updates?.byCall.get(line.tool_call_id) : undefined;
                    push({
                        kind: 'tool_result',
                        ...(line.tool_call_id ? { callId: line.tool_call_id } : {}),
                        toolResult: textOf(line.content) || String(line.content ?? ''),
                        // Grok stores the outcome in the event log, never on the result.
                        ...(timing ? { isError: timing.failed === true } : {}),
                        timestamp: timing?.endedAt ?? stream?.endedAt,
                        ...(timing?.durationMs !== undefined ? { durationMs: timing.durationMs } : {}),
                    });
                    break;
                }
                case 'backend_tool_call': {
                    const kind = line.kind?.tool_type ?? 'unknown';
                    stats.extras[`backend:${kind}`] = (stats.extras[`backend:${kind}`] ?? 0) + 1;
                    break;
                }
                default:
                    break;
            }
        }
        // The stream is only trusted when it produced exactly as many chunks of a
        // kind as the transcript has events of it; anything else means the two
        // files disagree about what happened, and then neither is a clock.
        const streams = {
            user: updates?.user ?? [],
            thought: (updates?.thought ?? []).map((chunk) => chunk.at),
            message: (updates?.message ?? []).map((chunk) => chunk.at),
        };
        for (const kind of ['user', 'thought', 'message']) {
            const stream = streams[kind];
            const where = positions[kind];
            if (!stream.length || stream.length !== where.length)
                continue;
            where.forEach((index, i) => {
                const event = turns[index];
                if (event && !event.timestamp)
                    event.timestamp = stream[i];
            });
        }
        // A task receipt names the log Grok writes under `terminal/`; keep the
        // pointer only while that file is still on disk.
        stats.backgroundTasks = await Promise.all(stats.backgroundTasks.map(async (task) => task.log && !(await fs.stat(task.log).then(() => true).catch(() => false))
            ? { id: task.id, ...(task.title ? { title: task.title } : {}), finished: task.finished }
            : task));
        title ??= firstPrompt;
        const workspace = summary?.info?.cwd
            ? canonicalizePath(summary.info.cwd)
            : workspaceFromProjectDir(path.basename(path.dirname(dir)));
        return {
            ref: {
                id: candidate.id,
                provider: 'grok',
                path: candidate.path,
                ...(title ? { title } : {}),
                titles: existingTitles([summary?.generated_title, 'ai'], [firstPrompt, 'prompt']),
                ...(summary?.session_summary ? { summary: summary.session_summary } : {}),
                ...(workspace ? { workspace } : {}),
                ...(summary?.created_at ? { createdAt: summary.created_at } : {}),
                updatedAt: summary?.updated_at ?? summary?.last_active_at ?? new Date(candidate.mtimeMs).toISOString(),
                sizeBytes: candidate.sizeBytes,
            },
            turns,
            artifacts,
            stats,
        };
    },
};
