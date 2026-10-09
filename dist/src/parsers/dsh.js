import { sourceEvents, existingTitles } from './source.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.js';
import { readZstdJsonl } from '../util/zstd.js';
import { canonicalizePath } from '../util/paths.js';
import { looksLikeInstructions, oneLine, stripPromptEnvelope } from '../util/text.js';
import { toolArgsOf } from './provider.js';
import { emptyProviderStats, } from '../types.js';
/** DeepSeek Harness keeps one directory per session under a slugified cwd. */
const SESSION_DIR = /^session-([0-9a-fA-F-]{36})$/;
const TRANSCRIPT = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/;
const SUPPORTED_VERSIONS = [2, 4];
/** The harness appends the status of a failed shell command to its output. */
const EXIT_CODE = /\[(?:exit code:\s*|Command finished with exit code\s+)(\d+)\]\s*$/i;
function unsupportedVersion(file, version) {
    const message = `unsupported DSH transcript v${version}: ${file}; supported versions: v2, v4`;
    process.emitWarning(message, { code: 'SESSION_FORMAT_UNSUPPORTED' });
    return new Error(message);
}
/** The harness injects catalogues and instructions as user messages. */
function isRealUser(source) {
    return (source?.kind ?? 'user') === 'user';
}
function textOf(blocks) {
    return (blocks ?? [])
        .map((block) => block?.text ?? '')
        .filter(Boolean)
        .join('\n');
}
function stamp(time) {
    return typeof time === 'number' && time > 0 ? new Date(time).toISOString() : undefined;
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
/** Dispatches on the extension so both spellings read the same way. */
async function* readLines(file, headBytes) {
    // A plain transcript is line-oriented, so a head read is a line budget.
    const lines = file.endsWith('.zstd')
        ? readZstdJsonl(file, { ...(headBytes ? { headBytes } : {}) })
        : readJsonl(file, headBytes ? { maxLines: 200 } : {});
    for await (const line of lines) {
        if (line.type === 'session' && typeof line.version === 'number' && !SUPPORTED_VERSIONS.includes(line.version)) {
            throw unsupportedVersion(file, line.version);
        }
        yield line;
    }
}
/** Prefer the current format when a migration leaves an older transcript alongside it. */
export async function dshTranscriptPath(dir) {
    const files = (await fs.readdir(dir).catch(() => []))
        .filter((name) => TRANSCRIPT.test(name))
        .sort((a, b) => Number(TRANSCRIPT.exec(b)[1]) - Number(TRANSCRIPT.exec(a)[1]) || a.localeCompare(b));
    for (const name of files) {
        const file = path.join(dir, name);
        if (!(await fs.stat(file).then((stat) => stat.isFile()).catch(() => false)))
            continue;
        const version = Number(TRANSCRIPT.exec(name)[1]);
        if (!SUPPORTED_VERSIONS.includes(version)) {
            unsupportedVersion(file, version);
            return undefined;
        }
        return file;
    }
    return undefined;
}
export const dshAdapter = {
    provider: 'dsh',
    async listCandidates() {
        const sessionsDir = path.join(os.homedir(), '.dsh', 'sessions');
        let projects;
        try {
            projects = await fs.readdir(sessionsDir);
        }
        catch {
            return [];
        }
        const found = [];
        for (const project of projects) {
            const dir = path.join(sessionsDir, project);
            for (const entry of await fs.readdir(dir).catch(() => [])) {
                // The directory is `session-<uuid>`; the id is the uuid, so a short id
                // means the same thing here as it does for every other provider.
                const id = SESSION_DIR.exec(entry)?.[1];
                if (!id)
                    continue;
                const file = await dshTranscriptPath(path.join(dir, entry));
                if (!file)
                    continue;
                const stat = await fs.stat(file).catch(() => undefined);
                if (!stat)
                    continue;
                found.push({ id, path: file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
            }
        }
        return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    },
    async scanRef(candidate) {
        let title;
        let workspace;
        let createdAt;
        // Frames are self-delimiting, so a head read decodes to a head of the
        // session — enough for the opening record and the title that follows it.
        for await (const raw of readLines(candidate.path, 64 * 1024)) {
            const line = raw;
            if (line.type === 'session') {
                createdAt ??= stamp(line.createdAt);
                if (typeof line.cwd === 'string')
                    workspace ??= canonicalizePath(line.cwd);
                continue;
            }
            const data = line.data ?? {};
            // The harness titles a session from its first prompt; that title wins.
            if (line.type === 'session/title' && typeof data.title === 'string')
                title = data.title;
            if (!title && line.type === 'user/message' && isRealUser(data.source)) {
                const text = stripPromptEnvelope(textOf(data.content));
                if (text && !looksLikeInstructions(text))
                    title = oneLine(text, 120);
            }
        }
        return {
            id: candidate.id,
            provider: 'dsh',
            path: candidate.path,
            // Spread rather than assign: the index stores an absent column as absent,
            // so an explicit `undefined` would make a cached ref differ from a parsed
            // one — and a session can genuinely be opened without ever being titled.
            ...(title ? { title } : {}),
            ...(workspace ? { workspace } : {}),
            ...(createdAt ? { createdAt } : {}),
            updatedAt: new Date(candidate.mtimeMs).toISOString(),
            sizeBytes: candidate.sizeBytes,
        };
    },
    async parse(candidate) {
        const turns = [];
        const sources = sourceEvents('dsh', candidate.id);
        const stats = emptyProviderStats();
        const tokens = { input: 0, output: 0, total: 0 };
        let cacheRead = 0;
        let title;
        const titles = [];
        let firstPrompt;
        let workspace;
        let createdAt;
        let updatedAt;
        let nativeTurnId;
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
        const count = (key) => {
            stats.extras[key] = (stats.extras[key] ?? 0) + 1;
        };
        for await (const raw of readLines(candidate.path)) {
            const line = raw;
            const message = (line.data?.message ?? {});
            const messageId = typeof line.data?.id === 'string' ? line.data.id : message.id;
            if (line.type === 'turn/start')
                nativeTurnId = String(line.data?.turn ?? stats.turnBoundaries.length + 1);
            sources.record(raw, line.seq !== undefined ? `seq:${line.seq}` : messageId, messageId, undefined, line.data?.turn !== undefined ? String(line.data.turn) : nativeTurnId);
            if (line.type === 'session') {
                createdAt ??= stamp(line.createdAt);
                if (typeof line.cwd === 'string')
                    workspace ??= canonicalizePath(line.cwd);
                if (line.delegationDepth)
                    stats.extras.delegationDepth = line.delegationDepth;
                continue;
            }
            const timestamp = stamp(line.time);
            if (timestamp)
                updatedAt = timestamp;
            const data = line.data ?? {};
            switch (line.type) {
                case 'session/title':
                    if (typeof data.title === 'string') {
                        title = data.title;
                        if (!titles.includes(title))
                            titles.push(title);
                    }
                    break;
                case 'model/selection':
                case 'request/context': {
                    const model = data.model;
                    if (model && !stats.models.includes(model))
                        stats.models.push(model);
                    break;
                }
                case 'turn/start':
                    stats.turnBoundaries.push({
                        id: String(data.turn ?? stats.turnBoundaries.length + 1),
                        ...(timestamp ? { startedAt: timestamp } : {}),
                        completed: false,
                    });
                    break;
                case 'turn/end': {
                    const id = String(data.turn ?? '');
                    const match = stats.turnBoundaries.find((boundary) => boundary.id === id && !boundary.completed);
                    const reason = data.reason?.kind ?? 'completed';
                    // `interrupted` and `aborted` end a turn without finishing it.
                    if (match && reason === 'completed') {
                        match.completed = true;
                        if (timestamp)
                            match.endedAt = timestamp;
                        if (match.startedAt && timestamp) {
                            match.durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(match.startedAt));
                        }
                    }
                    if (reason !== 'completed')
                        count(`turn:${reason}`);
                    break;
                }
                case 'user/message': {
                    const source = data.source;
                    if (!isRealUser(source)) {
                        count(`injected:${source?.kind ?? 'unknown'}`);
                        break;
                    }
                    const text = stripPromptEnvelope(textOf(data.content));
                    if (!text || looksLikeInstructions(text))
                        break;
                    firstPrompt ??= oneLine(text, 120);
                    push({ kind: 'user', text, timestamp });
                    break;
                }
                case 'assistant/message': {
                    const message = (data.message ?? {});
                    const model = message.source?.model;
                    if (model && !stats.models.includes(model))
                        stats.models.push(model);
                    const usage = data.usage;
                    if (usage) {
                        tokens.input += usage.inputTokens ?? 0;
                        tokens.output += usage.outputTokens ?? 0;
                        cacheRead += usage.cacheReadTokens ?? 0;
                    }
                    for (const block of message.content ?? []) {
                        // `tool-call` blocks restate the `tool/call` records that follow;
                        // taking both would double every tool call in the timeline.
                        if (block.type === 'reasoning' && block.text?.trim()) {
                            push({ kind: 'thinking', text: block.text, timestamp });
                        }
                        else if (block.type === 'text' && block.text?.trim()) {
                            push({ kind: 'assistant', text: block.text, timestamp });
                        }
                    }
                    break;
                }
                case 'tool/call':
                    push({
                        kind: 'tool_call',
                        ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
                        toolName: data.name,
                        toolArgs: parseArguments(data.arguments),
                        timestamp,
                    });
                    break;
                case 'tool/result': {
                    const message = (data.message ?? {});
                    const result = (message.content ?? []).find((block) => block.type === 'tool-result');
                    // v2 wraps a tool-result block; v4 stores a tool message directly.
                    const text = textOf(result ? result.content : message.content);
                    const exit = EXIT_CODE.exec(text.trimEnd());
                    const callId = result?.toolCallId ?? message.toolCallId;
                    push({
                        kind: 'tool_result',
                        ...(callId ? { callId } : {}),
                        toolResult: text,
                        isError: (result ? result.isError : message.isError) === true,
                        timestamp,
                        ...(exit ? { exitCode: Number(exit[1]) } : {}),
                    });
                    break;
                }
                case 'approval/asked':
                    count('approvals');
                    break;
                case 'subagent/descriptor':
                    count('subagents');
                    break;
                case 'step/start':
                    count('steps');
                    break;
                default:
                    break;
            }
        }
        return {
            ref: {
                id: candidate.id,
                provider: 'dsh',
                path: candidate.path,
                ...(title || firstPrompt ? { title: title ?? firstPrompt } : {}),
                titles: existingTitles(...titles.map((text) => [text, 'provider']), [firstPrompt, 'prompt']),
                ...(workspace ? { workspace } : {}),
                ...(createdAt ? { createdAt } : {}),
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
