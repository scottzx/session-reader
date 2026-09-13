import path from 'node:path';
import { isInside } from './util/paths.js';
import { clip, oneLine } from './util/text.js';
import { fileWrites, rawCommand, resolveWritePath } from './writes.js';
import type {
  DigestFocus,
  NormalizedSession,
  SessionDigest,
  TurnEvent,
  TurningPoint,
} from './types.js';

/** Paths a tool call wrote to, including files written through the shell. */
export function editedFiles(turn: TurnEvent, workspace?: string): string[] {
  return fileWrites(turn).map((write) => resolveWritePath(write, workspace));
}

export function shellCommand(turn: TurnEvent): string | undefined {
  const command = rawCommand(turn);
  return command ? oneLine(command, 200) : undefined;
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
    for (const file of editedFiles(turn, workspace)) touched.add(relativize(file, workspace));
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
