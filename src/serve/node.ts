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
import {
  PROTOCOL_VERSION,
  type AccessDescriptor,
  type NodeManifest,
  type Service as NetworkService,
  type SessionURI,
} from '@1agents/dreammate-network';

export { PROTOCOL_VERSION };
export type { AccessDescriptor, NetworkService, NodeManifest };

/* ---------- 身份 ---------- */

/** Where the node identity is kept, next to the index db. */
export function nodeIdentityPath(): string {
  return path.join(os.homedir(), '.1agents', 'session-reader', 'node.json');
}

const PLATFORM_TYPE: Record<string, string> = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
};

interface StoredIdentity {
  node_id: string;
  name: string;
  type: string;
}

/**
 * A stable node id that survives restarts, generated on first use and kept in
 * `~/.1agents/session-reader/node.json`.
 *
 * `DREAMMATE_NODE_ID` / `DREAMMATE_NODE_NAME` override it without touching the
 * file, which is what a container or a second instance on one host wants.
 */
export function nodeIdentity(): StoredIdentity {
  const type = PLATFORM_TYPE[process.platform] ?? process.platform;
  const envId = process.env.DREAMMATE_NODE_ID?.trim();
  const envName = process.env.DREAMMATE_NODE_NAME?.trim();
  if (envId && envName) return { node_id: envId, name: envName, type };

  const file = nodeIdentityPath();
  let stored: Partial<StoredIdentity> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredIdentity>;
  } catch {
    // First run, or an unreadable file we are about to overwrite.
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

export function buildManifest(baseUrl: string): NodeManifest {
  const identity = nodeIdentity();
  return {
    ...identity,
    tailscale_name: process.env.DREAMMATE_TAILSCALE_NAME?.trim() ?? identity.name,
    online: true,
    metadata: { protocol_version: PROTOCOL_VERSION },
    services: [
      {
        id: 'session-registry',
        name: 'session-reader',
        kind: 'session_registry',
        capabilities: [...SESSION_CAPABILITIES],
        resources: [{ scheme: 'session', description: 'session://<node>/<runtime>/<session_id>' }],
        access: [{ protocol: 'http', base_url: `${baseUrl}/v1` }],
      },
    ],
  };
}

/** `session://<node>/<runtime>/<session_id>` — the network-wide address of one session. */
export function sessionUri(nodeName: string, provider: string, id: string): SessionURI {
  return `session://${nodeName}/${provider}/${id}`;
}
