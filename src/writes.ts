import path from 'node:path';
import { canonicalizePath } from './util/paths.js';
import type { Provenance, TurnEvent } from './types.js';

export interface FileWrite {
  path: string;
  /** `observed` from a dedicated edit tool, `derived` from a shell command. */
  provenance: Provenance;
  /** The rule that produced it: `tool:Write`, `shell:redirect`, … */
  extractor: string;
  /** Set when the write happened inside `ssh user@host '…'`. */
  host?: string;
  event?: number;
}

const EDIT_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'write_to_file',
  'replace_file_content',
  'edit_file',
  'create_file',
  'apply_patch',
  'str_replace_editor',
  'search_replace',
]);
const FILE_ARGS = [
  'file_path',
  'filePath',
  'notebook_path',
  'target_file',
  'TargetFile',
  'AbsolutePath',
  'path',
];

const SHELL_TOOLS = new Set([
  'bash',
  'run_command',
  'run_terminal_command',
  'shell',
  'exec',
  'local_shell',
  'execute_command',
]);
const COMMAND_ARGS = ['command', 'CommandLine', 'cmd', 'input'];

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
/** Extensions we accept on a bare token. Without this, `a.name` looks like a file. */
const KNOWN_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|markdown|txt|csv|tsv|ya?ml|toml|ini|conf|cfg|sh|bash|zsh|fish|py|rb|go|rs|java|c|h|cpp|hpp|sql|html|css|scss|sql|log|png|jpe?g|gif|webp|svg|pdf|zip|tar|gz|safetensors|pt|pth|bin|lock|env|gitignore|dockerfile|patch|diff)$/i;

/**
 * Drops here-document bodies before scanning. Their content is data being
 * written, not commands — and when the payload is source code, its arrow
 * functions and string literals otherwise masquerade as redirects and hosts.
 */
export function stripHeredocs(command: string): string {
  return command.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    (match) => match.slice(0, match.indexOf('\n') + 1),
  );
}
/** `user@host` in an ssh/scp invocation — the bare `-o opt` forms carry no host. */
const SSH_HOST = /\b(?:ssh|scp|rsync)\b[^\n;|]*?\b[\w.-]+@([\w.-]+)/;

/** Shell constructs that create or overwrite a file, in order of specificity. */
const SHELL_PATTERNS: { via: string; re: RegExp }[] = [
  { via: 'tee', re: /\btee\s+(?:-a\s+)?(?:'([^']+)'|"([^"]+)"|([^\s'";|&)]+))/g },
  { via: 'sed-i', re: /\bsed\b[^\n;|]*?\s-i(?:\.\w+)?\s[^\n;|]*?\s(?:'([^']+)'|"([^"]+)"|([^\s'";|&)]+))\s*(?=$|[;|&\n'"])/g },
  { via: 'write-text', re: /(?:'([^']+)'|"([^"]+)")\s*\)?\s*\.write_text\(/g },
  { via: 'open-w', re: /\bopen\(\s*(?:'([^']+)'|"([^"]+)")\s*,\s*['"][wa]/g },
  // `=>` and `>=` are code, not redirection.
  { via: 'redirect', re: /(?<![0-9&=<>])>>?\s*(?:'([^']+)'|"([^"]+)"|([^\s'";|&<>)]+))/g },
];

function firstGroup(match: RegExpMatchArray): string | undefined {
  return match[1] ?? match[2] ?? match[3];
}

/** Resolves only what is already absolute; relative paths stay verbatim. */
function absolutize(candidate: string): string {
  const value = candidate.trim();
  return path.isAbsolute(value) || value.startsWith('~') || value.startsWith('file://')
    ? canonicalizePath(value)
    : value;
}

/** Rejects device files, globs, flags, URLs and file descriptors. */
function looksWritable(candidate: string): boolean {
  if (!candidate || candidate.length < 2) return false;
  if (candidate.startsWith('-') || candidate.startsWith('$')) return false;
  if (/^\/dev\//.test(candidate) || candidate === '/dev/null') return false;
  if (/[*?]/.test(candidate)) return false;
  if (/^\d+$/.test(candidate) || /^&/.test(candidate)) return false;
  if (/^[a-z]+:\/\//i.test(candidate)) return false;
  // Shell commands are often embedded in JSON/JS blobs; anything carrying
  // structural punctuation is a fragment of the wrapper, not a real path.
  if (/["`{}()<>,;|&$\n]/.test(candidate)) return false;
  if (/\[|\]/.test(candidate)) return false;
  // A bare token must carry a real file extension; `r.source` is a property.
  return candidate.includes('/') || KNOWN_EXT.test(candidate);
}

/**
 * Target of `cp`/`mv`/`install`/`scp`/`rsync` — always the last operand.
 * `scp remote:src local_dst` writes locally, so transfer tools only ever take
 * the host spelled on the target itself, never the one elsewhere in the line.
 */
function copyTargets(command: string): { path: string; via: string; host?: string; hostFromTargetOnly: boolean }[] {
  const out: { path: string; via: string; host?: string; hostFromTargetOnly: boolean }[] = [];
  for (const match of command.matchAll(/\b(cp|mv|install|scp|rsync)\b([^\n;|&]*)/g)) {
    const via = match[1]!;
    const operands = (match[2] ?? '')
      .split(/\s+/)
      .map((token) => token.replace(/^['"]+|['"]+$/g, ''))
      .filter((token) => token && !token.startsWith('-'));
    const target = operands.at(-1);
    if (!target || operands.length < 2) continue;
    const transfer = via === 'scp' || via === 'rsync';
    const remote = /^([\w.-]+)@([\w.-]+):(.+)$/.exec(target);
    if (remote) out.push({ path: remote[3]!, via, host: remote[2], hostFromTargetOnly: transfer });
    else if (looksWritable(target)) out.push({ path: target, via, hostFromTargetOnly: transfer });
  }
  return out;
}

/** The untruncated shell command a tool call carries, if it is a shell tool. */
export function rawCommand(turn: TurnEvent): string | undefined {
  if (turn.kind !== 'tool_call' || !SHELL_TOOLS.has((turn.toolName ?? '').toLowerCase())) return undefined;
  const args = turn.toolArgs ?? {};
  for (const key of COMMAND_ARGS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.length) return value.join(' ');
  }
  return undefined;
}

/**
 * The command as it should be analysed: here-doc payloads removed, so that
 * data being written never gets mistaken for commands being run.
 */
export function analyzableCommand(turn: TurnEvent): string | undefined {
  const raw = rawCommand(turn);
  return raw ? stripHeredocs(raw) : undefined;
}

/**
 * Files a single tool call wrote. Explicit writes come from dedicated edit
 * tools; inferred ones are parsed out of shell commands (heuristic — agents
 * that write through the shell would otherwise leave no trace at all).
 */
export function fileWrites(turn: TurnEvent): FileWrite[] {
  if (turn.kind !== 'tool_call') return [];
  const found: FileWrite[] = [];
  const toolName = (turn.toolName ?? '').toLowerCase();
  const args = turn.toolArgs ?? {};

  if (EDIT_TOOLS.has(toolName)) {
    for (const key of FILE_ARGS) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) {
        found.push({
          path: absolutize(value),
          provenance: 'observed',
          extractor: `tool:${turn.toolName}`,
          event: turn.index,
        });
      }
    }
    const patch = typeof args.input === 'string' ? args.input : '';
    for (const match of patch.matchAll(PATCH_FILE)) {
      if (match[1]) {
        found.push({
          path: absolutize(match[1].trim()),
          provenance: 'observed',
          extractor: 'patch:apply_patch',
          event: turn.index,
        });
      }
    }
  }

  const raw = rawCommand(turn);
  if (raw) {
    // Everything below reads the command, never the here-doc payload.
    const command = stripHeredocs(raw);
    const host = SSH_HOST.exec(command)?.[1];
    const add = (candidate: string, via: string, viaHost: string | undefined) => {
      if (!looksWritable(candidate)) return;
      // Remote paths must not be resolved against the local filesystem, and
      // relative ones belong to the session's workspace — not to our cwd.
      found.push({
        path: viaHost ? candidate : absolutize(candidate),
        // A shell write is a real action we saw run, just not a typed field.
        provenance: 'derived',
        extractor: `shell:${via}`,
        event: turn.index,
        ...(viaHost ? { host: viaHost } : {}),
      });
    };
    for (const { via, re } of SHELL_PATTERNS) {
      for (const match of command.matchAll(re)) {
        const candidate = firstGroup(match);
        if (candidate) add(candidate.trim(), via, host);
      }
    }
    for (const target of copyTargets(command)) {
      add(target.path, target.via, target.hostFromTargetOnly ? target.host : (target.host ?? host));
    }
  }

  const seen = new Set<string>();
  return found.filter((write) => {
    const key = `${write.host ?? ''}|${write.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Stable identity for a write: `host:path` when remote, otherwise an absolute
 * local path (relative ones resolved against the session's workspace).
 */
export function resolveWritePath(write: FileWrite, workspace?: string): string {
  if (write.host) return `${write.host}:${write.path}`;
  if (path.isAbsolute(write.path)) return write.path;
  return workspace ? path.resolve(workspace, write.path) : write.path;
}
