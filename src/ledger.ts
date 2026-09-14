import path from 'node:path';
import { isInside } from './util/paths.js';
import { oneLine } from './util/text.js';
import { analyzableCommand, fileWrites, rawCommand, resolveWritePath } from './writes.js';
import { turnNoAt, turnStarts } from './turns.js';
import type {
  AsyncJob,
  CommandRecord,
  FileGroup,
  FileRecord,
  JobStatus,
  NormalizedSession,
} from './types.js';

const SSH_HOST = /\b[\w.-]+@((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[\w-]+(?:\.[\w-]+)+))/;
const BACKGROUND = /\b(?:nohup|setsid|start_new_session\s*=\s*True|subprocess\.Popen|Popen\(|queue-[\w-]+\.py)\b/;
const LOG_PATH = /([\w./-]+\.log)\b/;
const PID_ECHO = /\b(?:pid|PID)[\s=:]+(\d{2,7})\b/;
const LOG_FILE = /(?:\.log|\.download\.log)$|progress\.jsonl?$/i;
const TEMP_DIR = /^\/(?:private\/)?(?:tmp|var\/folders)\//;

/** Maps each event index to the turn it belongs to. */
function turnOf(session: NormalizedSession): (index: number) => number {
  const starts = turnStarts(session);
  return (index: number) => (index < 0 ? 0 : turnNoAt(starts, index));
}

/**
 * Every shell command with whatever is known about how it went. Codex records
 * this itself; for the others we pair each call with the result that follows.
 */
export function commandLedger(session: NormalizedSession): CommandRecord[] {
  const toTurn = turnOf(session);

  if (session.stats.commands.length) {
    // Codex keeps its own ledger; align it with the event stream by order.
    const callIndexes = session.turns.filter((event) => rawCommand(event)).map((event) => event.index);
    return session.stats.commands.map((record, i) => {
      const eventIndex = callIndexes[i] ?? -1;
      return { ...record, eventIndex, turn: eventIndex >= 0 ? toTurn(eventIndex) : 0 };
    });
  }

  const records: CommandRecord[] = [];
  for (const event of session.turns) {
    const command = rawCommand(event);
    if (!command) continue;
    // The next tool_result is this command's outcome.
    const result = session.turns
      .slice(event.index + 1, event.index + 4)
      .find((candidate) => candidate.kind === 'tool_result');
    const host = SSH_HOST.exec(command)?.[1];
    records.push({
      eventIndex: event.index,
      turn: toTurn(event.index),
      command: oneLine(command, 300),
      provenance: 'derived',
      extractor: 'pair:tool_call+tool_result',
      ...(host ? { host } : {}),
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      // An explicit status wins; otherwise "provider did not flag an error"
      // is itself the provider's verdict, not a guess of ours.
      ...(result?.exitCode !== undefined
        ? { exitCode: result.exitCode }
        : result && result.isError === false
          ? { exitCode: 0 }
          : {}),
      ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(result?.isError && result.toolResult ? { stderr: oneLine(result.toolResult, 300) } : {}),
    });
  }
  return records;
}

/**
 * Failed commands, plus whether a similar command later succeeded.
 * A command counts as failed only on a non-zero exit, or on an unknown exit
 * that the provider itself flagged — never merely because stderr had content.
 */
export function errorLedger(session: NormalizedSession): CommandRecord[] {
  const commands = commandLedger(session);
  const failed = commands.filter(
    (record) => (record.exitCode !== undefined && record.exitCode !== 0) || (record.exitCode === undefined && record.stderr),
  );
  const prefix = (command: string) => command.split(/\s+/).slice(0, 3).join(' ');
  return failed.map((record) => ({
    ...record,
    laterSucceeded: commands.some(
      (other) =>
        other.eventIndex > record.eventIndex &&
        other.exitCode === 0 &&
        prefix(other.command) === prefix(record.command),
    ),
  }));
}

/** Background jobs, merged from provider receipts, shell launches and pids. */
export function jobLedger(session: NormalizedSession): AsyncJob[] {
  const jobs = new Map<string, AsyncJob>();

  for (const task of session.stats.backgroundTasks) {
    jobs.set(task.id, {
      id: task.id,
      ...(task.title ? { command: task.title } : {}),
      ...(task.log ? { log: task.log } : {}),
      provenance: 'observed',
      extractor: 'receipt:messages',
      status: task.finished ? 'completed' : 'unknown',
      evidence: task.finished ? ['provider 有完成回执'] : ['provider 记录了任务，但没有完成回执'],
    });
  }

  for (const event of session.turns) {
    const command = analyzableCommand(event);
    if (!command || !BACKGROUND.test(command)) continue;
    const segment = command.split(/[\n;]|&&/).find((part) => BACKGROUND.test(part)) ?? command;
    const log = LOG_PATH.exec(segment)?.[1] ?? LOG_PATH.exec(command)?.[1];
    const id = log ?? `event-${event.index}`;
    if (jobs.has(id)) continue;
    const host = SSH_HOST.exec(command)?.[1];
    jobs.set(id, {
      id,
      command: oneLine(segment, 200),
      ...(log ? { log } : {}),
      ...(host ? { host } : {}),
      ...(event.timestamp ? { startedAt: event.timestamp } : {}),
      discoveredFrom: event.index,
      provenance: 'derived',
      extractor: 'shell:background-launch',
      // No receipt, no claim: we only saw it start.
      status: 'unknown',
      evidence: [`事件 #${event.index} 启动了后台进程，会话内未见结束证据`],
    });
  }

  // A pid printed back by the shell is the only in-band proof a job existed.
  for (const event of session.turns) {
    if (event.kind !== 'tool_result') continue;
    const pid = PID_ECHO.exec(event.toolResult ?? '')?.[1];
    if (!pid) continue;
    const nearest = [...jobs.values()].find(
      (job) => job.discoveredFrom !== undefined && Math.abs(job.discoveredFrom - event.index) <= 2 && !job.pid,
    );
    if (nearest) {
      nearest.pid = pid;
      nearest.evidence.push(`结果里回显了 pid ${pid}`);
    }
  }

  return [...jobs.values()];
}

export function jobCounts(jobs: AsyncJob[]): Record<JobStatus, number> {
  const counts: Record<JobStatus, number> = { completed: 0, failed: 0, running: 0, unknown: 0 };
  for (const job of jobs) counts[job.status]++;
  return counts;
}

function groupOf(fullPath: string, host: string | undefined, workspace: string | undefined): FileGroup {
  if (LOG_FILE.test(fullPath) || TEMP_DIR.test(fullPath)) return 'log';
  if (host) return 'runtime';
  return workspace && isInside(workspace, fullPath) ? 'project' : 'runtime';
}

/** Every file the session wrote, bucketed by what kind of file it is. */
export function fileLedger(session: NormalizedSession): FileRecord[] {
  const toTurn = turnOf(session);
  const workspace = session.ref.workspace;
  const records = new Map<string, FileRecord>();

  for (const event of session.turns) {
    for (const write of fileWrites(event)) {
      const filePath = write.host ? write.path : resolveWritePath(write, workspace);
      const key = `${write.host ?? ''}|${filePath}`;
      if (records.has(key)) continue;
      records.set(key, {
        path: filePath,
        ...(write.host ? { host: write.host } : {}),
        operation: write.extractor.split(':').pop() ?? write.extractor,
        turn: toTurn(event.index),
        eventIndex: event.index,
        ...(event.timestamp ? { timestamp: event.timestamp } : {}),
        provenance: write.provenance,
        extractor: write.extractor,
        group: groupOf(filePath, write.host, workspace),
      });
    }
  }
  for (const change of session.stats.fileChanges) {
    const key = `|${change.path}`;
    if (records.has(key)) continue;
    records.set(key, {
      path: change.path,
      operation: change.change,
      turn: 0,
      eventIndex: -1,
      provenance: 'observed',
      extractor: 'item:FileChange',
      group: groupOf(change.path, undefined, workspace),
    });
  }
  return [...records.values()];
}

/** Display helper shared by the CLI: workspace-relative when possible. */
export function displayPath(record: FileRecord, workspace: string | undefined): string {
  if (record.host) return `${record.host}:${record.path}`;
  return workspace && isInside(workspace, record.path) ? path.relative(workspace, record.path) : record.path;
}
