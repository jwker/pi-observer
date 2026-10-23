/**
 * 探针与服务端之间的「服务地址」约定。
 *
 * 为什么要有这个文件：探针跑在用户的 Pi 进程里，服务端是另一个进程。
 * 两者要找到彼此，靠的原本只有环境变量 `PI_OBSERVER_URL` —— 但环境变量只能由启动
 * Pi 的那个人设置，桌面程序没法给已经在跑的 Pi 注入环境变量。所以改成：
 *
 *   谁启动服务端，谁把「我在哪」写进 `<数据目录>/probe.json`；
 *   探针启动时读这个文件，知道该往哪推数据。
 *
 * 桌面版要用随机端口时，桌面程序先选端口、写好这个文件，再起服务；
 * 探针下次启动就能找到它。已经在运行的 Pi 进程不会重读这个文件，要重启才生效。
 *
 * 文件里不放令牌：令牌有自己的一份（`<数据目录>/token`，0600），这里只放地址和路径。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** 配置文件名，放在数据目录下 */
export const PROBE_CONFIG_FILE_NAME = "probe.json";

/** 配置格式版本。往后加字段时递增；读方遇到不认识的大版本要能拒绝或降级 */
export const PROBE_CONFIG_VERSION = 1;

/**
 * 探针配置文件的形状。
 *
 * 三个字段都是可选的：文件可能只写了其中一项，剩下的由各自的默认值补齐。
 */
export interface ProbeFileConfig {
  version: number;
  /** 看板服务基地址，例如 `http://127.0.0.1:4173` */
  baseUrl?: string;
  /** 令牌文件路径 */
  tokenFile?: string;
  /** 正文文件根目录 */
  payloadDir?: string;
}

/** 配置文件在数据目录里的完整路径 */
export function probeConfigPath(dataDir: string): string {
  return join(dataDir, PROBE_CONFIG_FILE_NAME);
}

/**
 * 读配置文件。
 *
 * 文件不存在、读不了、不是合法 JSON，都返回 `null`：调用方据此退回默认值。
 * 单个字段不合法（地址不是 http、路径不是绝对路径）时只丢这一个字段，其余照常用。
 */
export function readProbeFileConfig(path: string): ProbeFileConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // 没有这个文件是正常情况（用默认地址跑）
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 写坏了就当没有
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const source = parsed as Record<string, unknown>;
  const config: ProbeFileConfig = {
    version: typeof source.version === "number" ? source.version : PROBE_CONFIG_VERSION,
  };

  if (typeof source.baseUrl === "string" && isHttpUrl(source.baseUrl)) {
    config.baseUrl = source.baseUrl.trim().replace(/\/+$/, "");
  }
  if (typeof source.tokenFile === "string" && isAbsolute(source.tokenFile)) {
    config.tokenFile = source.tokenFile;
  }
  if (typeof source.payloadDir === "string" && isAbsolute(source.payloadDir)) {
    config.payloadDir = source.payloadDir;
  }
  return config;
}

/**
 * 写配置文件。
 *
 * 先写临时文件再改名：探针随时可能在读，改名是原子的，不会读到半截内容。
 * 权限 0600 —— 文件里没有令牌，但路径信息（工作目录、会话 id）也算敏感。
 */
export function writeProbeFileConfig(path: string, config: ProbeFileConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    version: config.version,
    baseUrl: config.baseUrl,
    tokenFile: config.tokenFile,
    payloadDir: config.payloadDir,
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/** 只认 http / https，避免把 `file:` 之类的地址当成服务地址 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
