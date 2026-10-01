import type { SessionRef } from '../types.js';

export function sessionKey(session: Pick<SessionRef, 'provider' | 'id'>): string {
  return session.id.startsWith(`${session.provider}:`) ? session.id : `${session.provider}:${session.id}`;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A portable reference for an agent; visible turn numbers are only navigation aids. */
export function agentReference(session: SessionRef, target?: {
  locator?: string;
  callId?: string;
  artifactPath?: string;
  excerpt?: string;
}): string {
  const id = sessionKey(session);
  const selector = target?.artifactPath ? `--artifact ${quote(target.artifactPath)}`
    : target?.callId ? `--call ${quote(target.callId)}`
      : target?.locator ? `--locator ${quote(target.locator)}` : '';
  const command = selector ? `1session turn ${quote(id)} ${selector} --json` : `1session turns ${quote(id)} --json`;
  return [
    '请读取以下会话位置，结合前后文继续检索。',
    `会话：${id}`,
    ...(session.title ? [`标题：${session.title}`] : []),
    ...(session.workspace ? [`项目：${session.workspace}`] : []),
    ...(target?.locator ? [`消息定位：${target.locator}`] : []),
    ...(target?.callId ? [`工具调用：${target.callId}`] : []),
    ...(target?.artifactPath ? [`产物：${target.artifactPath}`] : []),
    `读取命令：${command}`,
    ...(target?.excerpt ? [`原文片段：\n${target.excerpt.slice(0, 600)}${target.excerpt.length > 600 ? '\n…（片段，完整内容请按引用读取）' : ''}`] : []),
  ].join('\n');
}
