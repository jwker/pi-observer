/**
 * pi-observer 探针（Pi 扩展）。
 *
 * 只有一个钩子：`before_provider_request`。
 *
 * 它做一件��：把这次请求的原始请求体写成文件，放到 iCloud 里的请求目录：
 *
 *     <requestStoreDir>/<会话 id>/req-<六位序号>-<紧凑时间戳>.json
 *
 * 文件名就是「唯一标识」：在看板的对话里能看到同名的标识，
 * 拿去 Finder / 编辑器里就能找到那一份请求正文。
 *
 * 约束：
 *   - 只读：不调用 Pi 的任何写入接口，不改 event 上的对象，不返回替换值；
 *   - 不发网络请求：探针不连看板，写完文件就结束；
 *   - 写文件失败不影响 Pi：异常只写一行日志，绝不抛给 Pi。
 *
 * 目录位置：环境变量 `PI_REQUEST_STORE_DIR` 优先，默认是
 * `~/Library/Mobile Documents/com~apple~CloudDocs/PiRequests`。
 */
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 请求正文的默认存放目录：iCloud Drive 下的一个文件夹 */
export const DEFAULT_REQUEST_STORE_DIR = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "PiRequests",
);

/** 文件名格式：`req-<六位序号>-<紧凑时间戳>` */
const NAME_PATTERN = /^req-(\d{6})-(\d{8}T\d{9}Z)\.json$/;

/** 目录名：会话 id 里的非法字符换成下划线 */
function safeSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned === id && cleaned.length <= 64) return cleaned;
  return cleaned.slice(0, 48);
}

/** 紧凑时间戳：`20261102T114049412Z` */
function compactTime(at: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return (
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}${pad(at.getUTCMilliseconds(), 3)}Z`
  );
}

/** 目录里已有的最大序号；没有文件时是 0 */
function maxSeq(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let max = 0;
  for (const name of names) {
    const match = NAME_PATTERN.exec(name);
    if (match === null) continue;
    const seq = Number(match[1]);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

/** 序列化成 JSON；失败时返回 null（不写空文件） */
function serialize(value: unknown): string | null {
  try {
    const json = JSON.stringify(value ?? null, null, 0);
    return typeof json === "string" ? json : null;
  } catch {
    return null;
  }
}

/** 请求目录 */
function requestDir(sessionId: string, root: string): string {
  return join(root, safeSegment(sessionId));
}

export default function probe(pi: ExtensionAPI): void {
  const root = process.env.PI_REQUEST_STORE_DIR ?? DEFAULT_REQUEST_STORE_DIR;

  pi.on("before_provider_request", (event, ctx: ExtensionContext) => {
    try {
      const sessionId = sessionIdOf(ctx);
      if (sessionId === null) return;

      const body = serialize(event.payload);
      if (body === null) return;

      const dir = requestDir(sessionId, root);
      mkdirSync(dir, { recursive: true });

      const seq = maxSeq(dir) + 1;
      const filename = `req-${String(seq).padStart(6, "0")}-${compactTime(new Date())}.json`;
      const target = join(dir, filename);

      // 先写临时文件再改名：iCloud 同步半个文件比同步一个坏文件麻烦
      const temp = `${target}.tmp`;
      writeFileSync(temp, body, "utf8");
      renameSync(temp, target);
    } catch (error) {
      // 写失败不影响 Pi：只在探针自己的日志里留一句
      log(`请求正文写入失败：${(error as Error).message}`);
    }
  });
}

/** 取会话 id；拿不到就返回 null（这次请求不写文件） */
function sessionIdOf(ctx: ExtensionContext): string | null {
  try {
    const id = ctx.sessionManager.getSessionId();
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

/** 探针日志：默认只写 stderr（Pi 进程里没有别的落点），一行一句 */
function log(message: string): void {
  try {
    process.stderr.write(`[pi-observer] ${message}\n`);
  } catch {
    // 连日志都失败就算了
  }
}

/** 导出目录名规则，供测试与文档使用 */
export const __testing = {
  safeSegment,
  compactTime,
  maxSeq,
  dirname,
};
