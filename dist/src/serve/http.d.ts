/**
 * `1session serve` — session-reader 作为 DreamMate Network 的第一个标准 Service。
 *
 * 它把本地 Read Plane 原样暴露成网络能力：`1session overview <id>` 成为
 * `sessions.read`。**不重新实现索引与事实层**，只是换一个调用入口。
 *
 * HTTP 层不引第三方框架，只用 node:http；端口与协议类型来自 L0 包。
 */
import http from 'node:http';
/** 约定端口，由 L0 协议包定义——Control Plane 的 pull 探测照着它找服务。 */
export declare const DEFAULT_PORT: 7777;
export interface ServeOptions {
    /** 默认 {@link DEFAULT_PORT}。换端口就探测不到了，得自己 register。 */
    port?: number;
    /**
     * Defaults to loopback. Session transcripts contain source code, shell
     * history and whatever secrets happened to scroll past, so going beyond this
     * machine has to be a deliberate act — pass the tailnet address explicitly.
     */
    host?: string;
    /** When set, every request must carry it as `Authorization: Bearer <token>`. */
    token?: string;
    /** Advertised base url, when behind a proxy or a different tailnet name. */
    baseUrl?: string;
    /**
     * 向本机 node agent 报备自己。默认开——agent 没起时是静默 no-op，没有代价。
     * 报备后外部探一个 36908 就能看见本服务，不必碰运气猜端口。
     */
    report?: boolean;
}
export declare function createServer(options?: ServeOptions): http.Server;
export declare function serve(options?: ServeOptions): Promise<http.Server>;
