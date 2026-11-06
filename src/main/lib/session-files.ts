/**
 * 会话文件的发现与「轻量元信息」。
 *
 * 列表页只需要知道每个会话文件在哪里、属于哪个项目、最后一条用户消息说了什么。
 * 这些都不用把整个文件读完：文件头是第一行 JSON，第一条用户消息通常也在前几行。
 * 所以列表页对 74 个文件（合计 131 MB）只读几十 KB。
 *
 * 完整解析在 `session-parse.ts`。
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { config } from "./config.ts";

export interface SessionFileMeta {
  session_id: string;
  cwd: string;
  file_path: string;
  /** 会话头里的创建时间 */
  started_at: string | null;
  /** 会话文件格式版本（当前是 3） */
  version: number | null;
  /** 分叉会话的父会话 id */
  parent_session: string | null;
  size_bytes: number;
  mtime_ms: number;
  /** 第一条用户消息的正文摘要（列表里的会话名） */
  first_user_text: string | null;
}

/** 列表页显示的摘要最多留这么多字符 */
const FIRST_TEXT_MAX = 200;

/** 读文件头时一次读多少字节；会话头加上第一条用户消息通常在这个范围内 */
const HEAD_BYTES = 64 * 1024;

/** 递归列出会话目录下的所有 .jsonl 文件（跳过隐藏目录） */
export function listSessionPaths(root: string = config().sessionsDir): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * 读一个会话文件的元信息。
 *
 * 读不出来（文件被删、权限不足、头不是合法 JSON）时返回 null，
 * 调用方把它跳过——列表页少一个会话比整页报错好。
 */
export function readSessionMeta(filePath: string): SessionFileMeta | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }

  const head = readHead(filePath);
  if (head === null) return null;

  let header: Record<string, unknown> | null = null;
  for (const line of head.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = parseJson(trimmed);
    if (parsed === null) continue;
    if (isObj(parsed) && parsed.type === "session") {
      header = parsed;
      break;
    }
    // 头不在第一行：继续往下找，但别把用户消息当头
    if (isObj(parsed) && parsed.type === "message") break;
  }

  const sessionId =
    header !== null && typeof header.id === "string" && header.id !== ""
      ? header.id
      : sessionIdFromName(filePath);
  const cwd = header !== null && typeof header.cwd === "string" ? header.cwd : "";

  return {
    session_id: sessionId,
    cwd,
    file_path: filePath,
    started_at: header !== null && typeof header.timestamp === "string" ? header.timestamp : null,
    version: header !== null && typeof header.version === "number" ? header.version : null,
    parent_session:
      header !== null && typeof header.parentSession === "string" ? header.parentSession : null,
    size_bytes: stat.size,
    mtime_ms: stat.mtimeMs,
    first_user_text: firstUserText(head),
  };
}

/**
 * 列出全部会话，按最后修改时间倒序。
 *
 * `limit` 是给列表页的保护：会话文件可能有几百个，页面不需要一次全给。
 */
export function listSessionMeta(limit = 500, root: string = config().sessionsDir): SessionFileMeta[] {
  const metas: SessionFileMeta[] = [];
  for (const path of listSessionPaths(root)) {
    const meta = readSessionMeta(path);
    if (meta !== null) metas.push(meta);
  }
  metas.sort((a, b) => (a.mtime_ms === b.mtime_ms ? (a.session_id < b.session_id ? 1 : -1) : b.mtime_ms - a.mtime_ms));
  return metas.slice(0, limit);
}

/**
 * 按会话 id 找到文件路径。
 *
 * 只看文件名：Pi 的会话文件名就是 `<时间戳>_<会话 id>.jsonl`，
 * 所以不必读文件内容就能定位。
 */
export function findSessionPath(sessionId: string, root: string = config().sessionsDir): string | null {
  const suffix = `_${sessionId}.jsonl`;
  for (const path of listSessionPaths(root)) {
    const name = path.split("/").pop() ?? "";
    if (name.endsWith(suffix)) return path;
  }
  return null;
}

/** 读文件开头的若干字节（按行切开） */
function readHead(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不影响读到的内容
      }
    }
  }
}

/** 头部里第一条用户消息的正文 */
function firstUserText(head: string): string | null {
  for (const line of head.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = parseJson(trimmed);
    if (!isObj(parsed) || parsed.type !== "message") continue;
    const message = isObj(parsed.message) ? parsed.message : null;
    if (message === null || message.role !== "user") continue;
    const text = textOfContent(message.content);
    if (text !== null) return text.length <= FIRST_TEXT_MAX ? text : `${text.slice(0, FIRST_TEXT_MAX)}…`;
  }
  return null;
}

/** 消息 content 里的 text 部分拼起来 */
export function textOfContent(content: unknown): string | null {
  if (typeof content === "string") return content === "" ? null : content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (isObj(item) && item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  const joined = parts.join("\n");
  return joined === "" ? null : joined;
}

function sessionIdFromName(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const underscore = name.indexOf("_");
  const tail = underscore >= 0 ? name.slice(underscore + 1) : name;
  return tail.replace(/\.jsonl$/, "");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
