/**
 * session-reader 作为 DreamMate Network Service 时的 manifest 构建。
 *
 * 节点身份不在这里实现——它是每台机器的公共事实，由 `@1agents/dreammate-node`
 * 统一提供（优先 tailnet，拿不到回退本地）。本机所有服务读到同一份，不会各自
 * 生成 id 把一台机器裂成几个 Node。
 */
import { nodeIdentity, type NodeIdentity } from '@1agents/dreammate-node';
import { PROTOCOL_VERSION, type AccessDescriptor, type NodeManifest, type Reachability, type Service as NetworkService, type SessionURI } from '@1agents/dreammate-network';
export { nodeIdentity, PROTOCOL_VERSION };
export type { AccessDescriptor, NetworkService, NodeIdentity, NodeManifest, Reachability };
/**
 * The capabilities this Service answers for. Names are the network-facing
 * spelling of the CLI verbs: `1session overview` is `sessions.read`.
 */
export declare const SESSION_CAPABILITIES: readonly ["sessions.list", "sessions.read", "sessions.turns", "sessions.search", "sessions.graph"];
export declare function buildManifest(baseUrl: string): Promise<NodeManifest>;
/**
 * `session://<node>/<runtime>/<session_id>` — 一个会话在网络中的地址。
 *
 * `nodeName` 应该来自 {@link nodeIdentity}，也就是 tailnet 的 DNSName 前缀。
 * **不要传 `os.hostname()`**：iOS 设备的 hostname 全是 `localhost`，几台手机
 * 接进来会产出一模一样的 `session://localhost/yima/...`。
 */
export declare function sessionUri(nodeName: string, provider: string, id: string): SessionURI;
