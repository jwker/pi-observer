/**
 * 运行配置：只有两个目录。
 *
 * 项目没有数据库，也没有服务进程内的写接口，所以配置退化成两个路径：
 *
 *   - `sessionsDir`     Pi 的会话文件根目录（只读）
 *   - `requestStoreDir` provider 请求正文的存放目录（探针写，页面只列文件名）
 *
 * 两个目录都可以用环境变量覆盖；默认值对应本机的常规位置。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface ObserverConfig {
  /** Pi 会话文件根目录 */
  sessionsDir: string;
  /** 请求正文存放目录；探针往里写，页面只读文件名 */
  requestStoreDir: string;
}

/** Pi 会话文件的默认位置 */
export const DEFAULT_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

/**
 * 请求正文的默认位置：iCloud Drive 下的一个文件夹。
 *
 * 放 iCloud 是有意的：请求正文可能很大，而且多数时候只是偶尔翻一翻；
 * 放在 iCloud 里不占本机磁盘，别的设备也能直接看到同一份文件。
 */
export const DEFAULT_REQUEST_STORE_DIR = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "PiRequests",
);

let cached: ObserverConfig | null = null;

export function config(): ObserverConfig {
  if (cached !== null) return cached;
  cached = {
    sessionsDir: process.env.PI_SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR,
    requestStoreDir: process.env.PI_REQUEST_STORE_DIR ?? DEFAULT_REQUEST_STORE_DIR,
  };
  return cached;
}

/** 测试用：换掉配置缓存 */
export function setConfig(next: ObserverConfig): void {
  cached = next;
}
