/**
 * session-reader 作为 DreamMate Network Service 时的 manifest 构建。
 *
 * 节点身份不在这里实现——它是每台机器的公共事实，由 `@1agents/dreammate-node`
 * 统一提供（优先 tailnet，拿不到回退本地）。本机所有服务读到同一份，不会各自
 * 生成 id 把一台机器裂成几个 Node。
 */
import { nodeIdentity, type NodeIdentity } from '@1agents/dreammate-node';
import {
  DEFAULT_PORTS,
  PROTOCOL_VERSION,
  type AccessDescriptor,
  type NodeManifest,
  type Reachability,
  type Service as NetworkService,
  type SessionURI,
} from '@1agents/dreammate-network';

export { nodeIdentity, PROTOCOL_VERSION };
export type { AccessDescriptor, NetworkService, NodeIdentity, NodeManifest, Reachability };

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
  const port = new URL(baseUrl).port || String(DEFAULT_PORTS['session-registry']);
  const at = (host: string): AccessDescriptor => ({
    protocol: 'http',
    base_url: `http://${host}:${port}/v1`,
  });

  // MagicDNS 名在前（可读，IP 变了也不用改），tailnet IP 兜底：调用方的 DNS
  // 可能被劫持——实测一台装了 fake-ip 代理的 Mac 会把 MagicDNS 名解析到
  // 198.18.x.x，只给名字的话那台机器就永远连不上。
  // 请求里的 Host 只是"调用方碰巧用了哪个地址"，两者都拿不到时才退回它。
  const access = [
    ...(identity.dnsName ? [at(identity.dnsName)] : []),
    ...(identity.ipv4 && identity.ipv4 !== identity.dnsName ? [at(identity.ipv4)] : []),
  ];

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
        access: access.length > 0 ? access : [{ protocol: 'http', base_url: `${baseUrl}/v1` }],
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
