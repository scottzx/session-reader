import path from 'node:path';
import { canonicalizePath, isInside } from './util/paths.js';
import { clip, oneLine } from './util/text.js';
import type {
  DigestFocus,
  NormalizedSession,
  SessionDigest,
  TurnEvent,
  TurningPoint,
} from './types.js';

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
]);
const SHELL_TOOLS = new Set(['bash', 'run_command', 'shell', 'exec', 'local_shell', 'execute_command']);
const FILE_ARGS = ['file_path', 'filePath', 'notebook_path', 'TargetFile', 'AbsolutePath', 'path'];
const COMMAND_ARGS = ['command', 'CommandLine', 'cmd', 'input'];
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

const toolNameOf = (turn: TurnEvent): string => (turn.toolName ?? '').toLowerCase();

/** Absolute paths a single tool call wrote to. */
export function editedFiles(turn: TurnEvent): string[] {
  if (turn.kind !== 'tool_call' || !EDIT_TOOLS.has(toolNameOf(turn))) return [];
  const args = turn.toolArgs ?? {};
  const files: string[] = [];
  for (const key of FILE_ARGS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) files.push(canonicalizePath(value));
  }
  const patch = typeof args.input === 'string' ? args.input : '';
  for (const match of patch.matchAll(PATCH_FILE)) {
    if (match[1]) files.push(canonicalizePath(match[1].trim()));
  }
  return files;
}

export function shellCommand(turn: TurnEvent): string | undefined {
  if (turn.kind !== 'tool_call' || !SHELL_TOOLS.has(toolNameOf(turn))) return undefined;
  const args = turn.toolArgs ?? {};
  for (const key of COMMAND_ARGS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value, 200);
    if (Array.isArray(value) && value.length) return oneLine(value.join(' '), 200);
  }
  return undefined;
}

function relativize(file: string, workspace: string | undefined): string {
  return workspace && isInside(workspace, file) ? path.relative(workspace, file) || '.' : file;
}

function collectTurningPoints(turns: TurnEvent[]): TurningPoint[] {
  const points: TurningPoint[] = [];
  const users = turns.filter((t) => t.kind === 'user' && t.text?.trim());
  users.forEach((turn, i) => {
    points.push({
      timestamp: turn.timestamp,
      kind: i === 0 ? 'request' : 'redirect',
      text: oneLine(turn.text, 220),
    });
  });
  for (const turn of turns.filter((t) => t.kind === 'tool_result' && t.isError).slice(0, 5)) {
    points.push({ timestamp: turn.timestamp, kind: 'failure', text: oneLine(turn.toolResult, 200) });
  }
  const final = [...turns].reverse().find((t) => t.kind === 'assistant' && t.text?.trim());
  if (final) {
    points.push({ timestamp: final.timestamp, kind: 'outcome', text: oneLine(final.text, 300) });
  }
  return points.sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''));
}

function bullets(items: string[], max: number): string {
  const shown = items.slice(0, max).map((item) => `- ${item}`);
  if (items.length > max) shown.push(`- …另有 ${items.length - max} 项`);
  return shown.length ? shown.join('\n') : '- （无）';
}

const KIND_LABEL: Record<TurningPoint['kind'], string> = {
  request: '需求',
  redirect: '转向',
  failure: '受阻',
  outcome: '结论',
};

function render(digest: Omit<SessionDigest, 'markdown'>, turns: TurnEvent[], focus: DigestFocus): string {
  const { session, goal, touchedFiles, commands, turningPoints, artifacts } = digest;
  const head = [
    `# ${session.title ?? session.id}`,
    '',
    `- 智能体：${session.provider}　会话：\`${session.id}\``,
    `- 工作区：${session.workspace ?? '未知'}`,
    `- 时间：${session.createdAt ?? '?'} → ${session.updatedAt ?? '?'}`,
    `- 规模：${turns.length} 轮事件，改动 ${touchedFiles.length} 个文件，执行 ${commands.length} 条命令`,
    '',
    '## 目标',
    '',
    goal || '（未能识别）',
    '',
  ];

  const files = ['## 改动的文件', '', bullets(touchedFiles, 25), ''];
  const points = [
    '## 关键节点',
    '',
    turningPoints.length
      ? turningPoints
          .slice(0, 10)
          .map((p) => `- **${KIND_LABEL[p.kind]}**：${p.text}`)
          .join('\n')
      : '- （无）',
    '',
  ];
  const artifactSection = artifacts.length
    ? ['## 产出物', '', bullets(artifacts.map((a) => `${a.name} — ${a.path}`), 10), '']
    : [];

  if (focus === 'marketing') {
    const highlights = turningPoints.filter((p) => p.kind !== 'request').slice(0, 6);
    return [
      ...head,
      '## 亮点',
      '',
      highlights.length ? highlights.map((p) => `- ${KIND_LABEL[p.kind]}：${p.text}`).join('\n') : '- （无）',
      '',
      ...files,
      ...artifactSection,
    ].join('\n');
  }

  const body = [...head, ...files, '## 执行的命令', '', bullets(commands, 15), '', ...points, ...artifactSection];
  if (focus === 'review') return body.join('\n');

  const skeleton = turns
    .map((turn) => {
      const label = turn.toolName ? `${turn.kind}(${turn.toolName})` : turn.kind;
      return `${String(turn.index).padStart(3, ' ')} ${label}: ${oneLine(turn.text ?? turn.toolResult, 110)}`;
    })
    .slice(0, 120);
  return [...body, '## 轮次骨架', '', '```', ...skeleton, '```', ''].join('\n');
}

export function distillSession(
  session: NormalizedSession,
  options: { focus?: DigestFocus } = {},
): SessionDigest {
  const focus = options.focus ?? 'review';
  const workspace = session.ref.workspace;
  const touched = new Set<string>();
  const commands: string[] = [];

  for (const turn of session.turns) {
    for (const file of editedFiles(turn)) touched.add(relativize(file, workspace));
    const command = shellCommand(turn);
    if (command && !commands.includes(command)) commands.push(command);
  }

  const firstUser = session.turns.find((t) => t.kind === 'user' && t.text?.trim());
  const digest: Omit<SessionDigest, 'markdown'> = {
    session: session.ref,
    goal: clip(firstUser?.text, focus === 'full' ? 1200 : 400),
    touchedFiles: [...touched].sort(),
    commands,
    turningPoints: collectTurningPoints(session.turns),
    artifacts: session.artifacts,
  };
  return { ...digest, markdown: render(digest, session.turns, focus) };
}
