/**
 * Node identity and Manifest — session-reader 作为 DreamMate Network 的第一个标准 Service。
 *
 * 协议类型直接来自 L0 包 `@1agents/dreammate-network`，不再本地抄一份：
 * 单向依赖 L2 → L0 是允许的，而共用同一份定义才谈得上「公共语言」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nodeTypeOf, tailscaleSelf } from './tailscale.js';
import {
  DEFAULT_PORTS,
  PROTOCOL_VERSION,
  type AccessDescriptor,
  type NodeManifest,
  type Service as NetworkService,
  type SessionURI,
} from '@1agents/dreammate-network';

export { PROTOCOL_VERSION };
export type { AccessDescriptor, NetworkService, NodeManifest };

/* ---------- 身份 ---------- */

/** 回退身份的存放位置，与索引库并排。 */
export function nodeIdentityPath(): string {
  return path.join(os.homedir(), '.1agents', 'node.json');
}

const PLATFORM_TYPE: Record<string, string> = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
};

export interface NodeIdentity {
  node_id: string;
  name: string;
  type: string;
  /** 身份是从哪来的——诊断用，也让调用方知道该不该信任 `name` 的唯一性。 */
  source: 'tailscale' | 'local';
  /** MagicDNS 名，仅 tailscale 来源时有。 */
  dnsName?: string;
}

/**
 * 本机在网络中的身份。
 *
 * **优先 tailscale**：tailnet 已经维护了稳定 ID、唯一名字和操作系统，
 * 本机所有服务读到的是同一份，不会各自生成 id 把一台机器裂成几个 Node。
 *
 * 拿不到就回退到本地身份（hostname + 首次生成的 uuid，存在
 * `~/.1agents/node.json`）。注意回退身份的 `name` 不保证跨设备唯一——
 * iOS 的 hostname 全是 `localhost`——所以只适合单机自用。
 *
 * `DREAMMATE_NODE_ID` / `DREAMMATE_NODE_NAME` 覆盖一切，容器或同机第二个
 * 实例需要时用。
 */
export async function nodeIdentity(): Promise<NodeIdentity> {
  const envId = process.env.DREAMMATE_NODE_ID?.trim();
  const envName = process.env.DREAMMATE_NODE_NAME?.trim();

  const ts = await tailscaleSelf();
  if (ts) {
    return {
      node_id: envId ?? ts.id,
      name: envName ?? ts.name,
      type: nodeTypeOf(ts.os),
      source: 'tailscale',
      dnsName: ts.dnsName,
    };
  }

  const type = PLATFORM_TYPE[process.platform] ?? process.platform;
  if (envId && envName) return { node_id: envId, name: envName, type, source: 'local' };

  const file = nodeIdentityPath();
  let stored: Partial<NodeIdentity> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<NodeIdentity>;
  } catch {
    // 首次运行，或者文件坏了——下面会覆盖掉。
  }
  if (!stored.node_id) {
    stored = { node_id: `node_${randomUUID().replace(/-/g, '').slice(0, 12)}`, name: os.hostname(), type };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  }
  return {
    node_id: envId ?? stored.node_id!,
    name: envName ?? stored.name ?? os.hostname(),
    type,
    source: 'local',
  };
}

/* ---------- Manifest ---------- */

/**
 * The capabilities this Service answers for. Names are the network-facing
 * spelling of the CLI verbs: `1session overview` is `sessions.read`.
 */
export const SESSION_CAPABILITIES = [
  'sessions.list',
  'sessions.read',
  'sessions.turns',
  'sessions.search',
  'sessions.graph',
] as const;

export async function buildManifest(baseUrl: string): Promise<NodeManifest> {
  const identity = await nodeIdentity();
  // 有 MagicDNS 就用它：`http://scott-mac:7777` 跨网络稳定，不怕 IP 变，
  // 而请求里的 Host 只是"调用方碰巧用了哪个地址"。
  const advertised = identity.dnsName
    ? baseUrl.replace(/\/\/[^/]+/, `//${identity.dnsName}:${new URL(baseUrl).port || String(DEFAULT_PORTS['session-registry'])}`)
    : baseUrl;
  return {
    node_id: identity.node_id,
    name: identity.name,
    type: identity.type,
    tailscale_name: identity.dnsName ?? process.env.DREAMMATE_TAILSCALE_NAME?.trim() ?? null,
    online: true,
    metadata: { protocol_version: PROTOCOL_VERSION, identity_source: identity.source },
    services: [
      {
        id: 'session-registry',
        name: 'session-reader',
        kind: 'session_registry',
        capabilities: [...SESSION_CAPABILITIES],
        resources: [{ scheme: 'session', description: 'session://<node>/<runtime>/<session_id>' }],
        access: [{ protocol: 'http', base_url: `${advertised}/v1` }],
      },
    ],
  };
}

/**
 * `session://<node>/<runtime>/<session_id>` — 一个会话在网络中的地址。
 *
 * `nodeName` 应该来自 {@link nodeIdentity}，也就是 tailnet 的 DNSName 前缀。
 * **不要传 `os.hostname()`**：iOS 设备的 hostname 全是 `localhost`，几台手机
 * 接进来会产出一模一样的 `session://localhost/yima/...`。
 */
export function sessionUri(nodeName: string, provider: string, id: string): SessionURI {
  return `session://${nodeName}/${provider}/${id}`;
}
