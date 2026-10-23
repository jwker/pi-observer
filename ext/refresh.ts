/**
 * 刷新探针配置。
 *
 * 场景：看板换了地址（桌面版自己挑空闲端口、服务重启后端口变了）。
 * 环境变量注入不到已经在跑的 Pi 进程里，所以只能重读配置文件。
 * 连不上的时候重读一次，变了就换过去——用户不用重开 Pi 会话。
 *
 * 单独成文件是为了能测：这里只做「比新旧、算出要不要换」，
 * 读文件、读环境变量那些副作用留在调用方。
 */
import type { ProbeConfig } from "./config.ts";

export interface ConfigRefreshResult {
  /** 刷新后的配置；没变化时就是原来那份 */
  config: ProbeConfig;
  /** 配置是不是真的变了 */
  changed: boolean;
  /** 令牌文件是不是变了：变了的话缓存里的令牌作废，下一批要重读 */
  tokenFileChanged: boolean;
}

/**
 * 拿新配置跟当前配置比。
 *
 * `load` 读不到配置时抛错——这时保持原样，不能因为一次读失败就把地址清空。
 */
export function refreshProbeConfig(
  current: ProbeConfig,
  load: () => ProbeConfig,
): ConfigRefreshResult {
  let next: ProbeConfig;
  try {
    next = load();
  } catch {
    return { config: current, changed: false, tokenFileChanged: false };
  }

  const changed =
    next.baseUrl !== current.baseUrl ||
    next.tokenFile !== current.tokenFile ||
    next.payloadDir !== current.payloadDir;
  if (!changed) {
    return { config: current, changed: false, tokenFileChanged: false };
  }
  return {
    config: next,
    changed: true,
    tokenFileChanged: next.tokenFile !== current.tokenFile,
  };
}
