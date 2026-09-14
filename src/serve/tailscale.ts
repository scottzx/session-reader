/**
 * Tailscale 作为 Node 层的事实源。
 *
 * tailnet 已经维护了我们需要的全部节点信息——稳定 ID、唯一名字、操作系统、
 * 地址、在线状态——再自己生成一份只会和它打架。所以有 tailscale 就用它，
 * 没有就回退（见 node.ts）。
 *
 * 它**不**知道的是 Service 层：哪个端口上跑着什么，得我们自己声明。
 *
 * 零依赖：只用 node:child_process。
 */
import { execFile } from 'node:child_process';

export interface TailscaleSelf {
  /** tailnet 内稳定且唯一，重启不变。 */
  id: string;
  /**
   * DNSName 的第一段。**不要用 HostName**——iOS 设备的 HostName 全是
   * `localhost`，实测 11 个节点里只有 9 个唯一；DNSName 是 11/11 唯一，
   * 而且可读（iphone-15-pro）。
   */
  name: string;
  /** macOS / linux / windows / iOS / android → 我们的 node.type */
  os: string;
  ipv4?: string;
  /** MagicDNS 全名，去掉末尾的点。 */
  dnsName: string;
}

const OS_TO_NODE_TYPE: Record<string, string> = {
  macOS: 'macos',
  linux: 'linux',
  windows: 'windows',
  iOS: 'ios',
  android: 'android',
};

/** tailscale 的 OS 值转成我们 schema 的 node.type，未知值原样保留。 */
export function nodeTypeOf(os: string): string {
  return OS_TO_NODE_TYPE[os] ?? os.toLowerCase();
}

interface RawStatus {
  BackendState?: string;
  Self?: {
    ID?: string;
    HostName?: string;
    DNSName?: string;
    OS?: string;
    TailscaleIPs?: string[];
  };
}

/**
 * 跑一次 `tailscale status --json`。
 *
 * 任何不顺利都返回 undefined 而不是抛错：没装、没登录、CLI 卡住、
 * 输出变了格式——这些都只该让我们回退，不该让 serve 起不来。
 * stderr 会有版本不匹配的告警，忽略即可，只读 stdout。
 */
function readStatus(timeoutMs: number): Promise<RawStatus | undefined> {
  return new Promise((resolve) => {
    execFile(
      'tailscale',
      ['status', '--json'],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout) return resolve(undefined);
        try {
          resolve(JSON.parse(stdout) as RawStatus);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

let cache: { at: number; value: TailscaleSelf | undefined } | undefined;

/** 默认缓存窗口。节点身份几乎不变，而每个请求都 fork 一次 CLI 是浪费。 */
export const CACHE_MS = 60_000;

/**
 * 本机在 tailnet 里的身份，拿不到就是 `undefined`。
 *
 * 结果缓存 {@link CACHE_MS}，`force` 可以跳过缓存。
 */
export async function tailscaleSelf(
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<TailscaleSelf | undefined> {
  const now = Date.now();
  if (!options.force && cache && now - cache.at < CACHE_MS) return cache.value;

  const status = await readStatus(options.timeoutMs ?? 2_000);
  const self = status?.Self;
  // 未登录时 Self 仍在，但 BackendState 不是 Running，此时的身份不可信。
  const usable =
    status?.BackendState === 'Running' && self?.ID && self.DNSName
      ? ({
          id: self.ID,
          name: self.DNSName.replace(/\.$/, '').split('.')[0]!,
          os: self.OS ?? '',
          ipv4: self.TailscaleIPs?.find((ip) => ip.includes('.')),
          dnsName: self.DNSName.replace(/\.$/, ''),
        } satisfies TailscaleSelf)
      : undefined;

  cache = { at: now, value: usable };
  return usable;
}

/** 测试用：清掉缓存。 */
export function resetTailscaleCache(): void {
  cache = undefined;
}
