import http from 'node:http';
export declare const DEFAULT_WEB_PORT = 7780;
export interface WebOptions {
    port?: number;
    host?: string;
    /** Workspace the UI treats as "当前工作区". Defaults to process.cwd(). */
    cwd?: string;
    /** Initial scope dropdown: cwd (default) or global. */
    defaultScope?: 'cwd' | 'global';
    /** Open the page in the default browser after listen. */
    open?: boolean;
}
export interface SrUiBoot {
    mode: 'standalone';
    cwd: string;
    title: string;
    defaultScope: 'cwd' | 'global';
}
export declare function renderIndexHtml(boot: SrUiBoot): string;
export declare function serveWeb(options?: WebOptions): Promise<http.Server>;
