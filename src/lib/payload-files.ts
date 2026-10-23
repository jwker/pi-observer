/**
 * payload 文件布局：正文存文件，数据库只留关系与路径。
 *
 * 目录结构（相对 `data/payloads/`）：
 *   request/<会话键>/<request_seq>.json    模型请求的完整请求体
 *   event/<会话键>/<event_id>.json         探针事件
 *   message/<会话键>/<entry_id>.json       会话文件回填的条目
 *
 * 探针与服务端都用这个模块，保证两边算出来的路径一致。
 * 探针把文件写在自己那一侧，服务端按同一套相对路径解析；
 * 两边的数据目录必须一致（默认都是 <repo>/data），否则服务端会记一条警告。
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type PayloadKind = "request" | "event" | "message";

/** 正文在文件里的引用。 */
export interface PayloadRef {
  /** 相对 payloads 根目录的路径，用 `/` 分隔 */
  path: string;
  /** 原始字节数 */
  bytes: number;
}

/** payloads 根目录 */
export function payloadsRoot(dataDir: string): string {
  return join(dataDir, "payloads");
}

/**
 * 把任意标识变成能安全当文件名的片段。
 *
 * 会话 id 与条目 id 一般已经是安全字符（UUID / 短哈希），直接用；
 * 遇到别的字符就替换掉，并附上原值的哈希前缀，避免两个不同 id 撞成同一个文件名。
 */
export function safeSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned === id && cleaned.length <= 64) return cleaned;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 8);
  const base = cleaned.slice(0, 48).replace(/^\.+/, "_") || "x";
  return `${base}-${digest}`;
}

/** 某个正文文件的相对路径 */
export function payloadRelPath(kind: PayloadKind, sessionId: string, id: string): string {
  return `${kind}/${safeSegment(sessionId)}/${safeSegment(id)}.json`;
}

/**
 * 把相对路径解析成绝对路径，并确认它没有跑出 payloads 根目录。
 *
 * 返回 null 表示路径不合法（越界、绝对路径、空路径）。
 */
export function resolvePayloadPath(root: string, relPath: string): string | null {
  if (typeof relPath !== "string" || relPath === "") return null;
  if (relPath.includes("\0")) return null;
  if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) return null;

  const rootAbs = resolve(root);
  const target = resolve(rootAbs, relPath);
  const inside = relative(rootAbs, target);
  if (inside === "" || inside.startsWith("..") || inside.startsWith(`..${sep}`)) return null;
  return target;
}

/**
 * 原子写：先写临时文件再改名，读者不会看到写了一半的内容。
 *
 * 权限：目录 0700、文件 0600。正文是**原样的**请求体（含系统提示、全部对话历史，
 * 用户在对话里贴的东西也会原样落盘），不脱敏也不自动清理——
 * 所以它至少要跟令牌文件一样只对本机用户可读。默认的 0644 会让同机其他用户读到。
 */
export function writePayloadFile(root: string, relPath: string, content: string): number {
  const target = resolvePayloadPath(root, relPath);
  if (target === null) throw new Error(`payload 路径不合法：${relPath}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const bytes = Buffer.byteLength(content, "utf8");
  const temp = `${target}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  // rename 在同一文件系统内是原子的
  renameSync(temp, target);
  return bytes;
}

/**
 * 把已有的正文目录与文件收紧到只对本机用户可读。
 *
 * 之前的版本用默认 umask 写（0644），老文件要主动收一次。
 */
export function tightenPayloadPermissions(root: string): number {
  let changed = 0;
  const tightenDir = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    try {
      chmodSync(dir, 0o700);
    } catch {
      // 权限改不了就算了，不影响读
    }
    for (const name of entries) {
      const full = join(dir, name);
      let stats: Stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) tightenDir(full);
      else if (name.endsWith(".json")) {
        try {
          chmodSync(full, 0o600);
          changed += 1;
        } catch {
          // 同上
        }
      }
    }
  };
  tightenDir(root);
  return changed;
}

/** 读一个正文文件；文件不在或读不了时返回 null */
export function readPayloadFile(root: string, relPath: string): string | null {
  const target = resolvePayloadPath(root, relPath);
  if (target === null) return null;
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

/** 读一个正文文件并解析成 JSON；文件不在或不是合法 JSON 时返回 null */
export function readPayloadJson(root: string, relPath: string | null): unknown {
  if (relPath === null) return null;
  const content = readPayloadFile(root, relPath);
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export interface DirUsage {
  /** 总字节数 */
  bytes: number;
  /** 文件数 */
  files: number;
}

/** 统计一个目录占多少字节、多少文件 */
export function dirUsage(dir: string): DirUsage {
  let bytes = 0;
  let files = 0;

  const walk = (current: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        bytes += statSync(full).size;
        files += 1;
      } catch {
        // 统计期间文件被删了，跳过
      }
    }
  };

  walk(dir);
  return { bytes, files };
}

/**
 * 生成「骨架」：保留 JSON 结构，把长字符串截短。
 *
 * 时间线与工具列表的查询直接用 SQL 读 `messages.payload` 的结构（角色、内容类型、
 * 工具参数），所以库里要留一份截短后的骨架；完整正文在文件里。
 */
export function summarizePayload(value: unknown, maxString = 200, maxArray = 50, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return String(value);
  if (depth >= 16) return "[深度超限]";

  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((item) => summarizePayload(item, maxString, maxArray, depth + 1));
    if (value.length > maxArray) items.push(`[共 ${value.length} 项，已截断]`);
    return items;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = summarizePayload(item, maxString, maxArray, depth + 1);
  }
  return output;
}
