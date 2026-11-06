/**
 * provider 请求正文目录。
 *
 * 探针把每次请求的原始请求体写成文件，放在
 * `<requestStoreDir>/<会话 id>/req-<序号>-<时间>.json`。
 *
 * 这个项目**不读这些文件的内容**：页面只列文件名，
 * 把「请求」和「对话里的哪一条助手消息」对上号就够了。
 * 正文要在别处看（Finder、iCloud、编辑器）自己打开。
 *
 * 对号规则：请求与响应是串行的，所以一条助手消息对应的请求，
 * 就是「时间不晚于这条助手消息、且还没有被用掉」的最后那个请求文件。
 * 中途失败重试会多出一个请求文件，多出来的那个自然对不上任何助手消息。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.ts";
import type { ParsedEntry } from "./session-parse.ts";

export interface RequestFileMeta {
  /** 文件名（不含扩展名）——这就是页面上显示的唯一标识 */
  id: string;
  /** 完整文件名 */
  filename: string;
  /** 绝对路径 */
  path: string;
  /** 会话内的请求序号 */
  seq: number;
  /** 文件名里的写入时间 */
  written_at: string | null;
  /** 文件字节数；只在用到时才 stat */
  size_bytes: number | null;
}

/** 文件名格式：`req-<六位序号>-<紧凑时间戳>` */
const NAME_PATTERN = /^req-(\d{6})-(\d{8}T\d{9}Z)$/;

/** 生成请求文件名（探针与页面共用这套规则） */
export function requestFileName(seq: number, at: Date): string {
  const pad = String(seq).padStart(6, "0");
  return `req-${pad}-${compactTime(at)}.json`;
}

/** 目录名：会话 id */
export function requestDirName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 某个会话的请求目录 */
export function requestDir(sessionId: string): string {
  return join(config().requestStoreDir, requestDirName(sessionId));
}

/** 解析文件名；不是本项目的文件返回 null */
export function parseRequestFileName(filename: string): { seq: number; written_at: string | null } | null {
  const match = NAME_PATTERN.exec(filename.replace(/\.json$/, ""));
  if (match === null) return null;
  const seq = Number(match[1]);
  if (!Number.isFinite(seq)) return null;
  return { seq, written_at: isoFromCompact(match[2]) };
}

/**
 * 列出会话的请求文件（只看文件名，不读内容）。
 *
 * 目录不存在时返回空数组：没装探针、或者探针还没写过，都是正常情况。
 */
export function listRequestFiles(sessionId: string): RequestFileMeta[] {
  const dir = requestDir(sessionId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: RequestFileMeta[] = [];
  for (const filename of names) {
    const parsed = parseRequestFileName(filename);
    if (parsed === null) continue;
    files.push({
      id: filename.replace(/\.json$/, ""),
      filename,
      path: join(dir, filename),
      seq: parsed.seq,
      written_at: parsed.written_at,
      size_bytes: null,
    });
  }
  files.sort((a, b) => {
    const at = a.written_at ?? "";
    const bt = b.written_at ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.seq - b.seq;
  });
  return files;
}

/** 取文件大小；文件没了返回 null */
export function requestFileSize(file: RequestFileMeta): number | null {
  if (file.size_bytes !== null) return file.size_bytes;
  try {
    const stat = statSync(file.path);
    file.size_bytes = stat.size;
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * 把请求文件对上助手消息。
 *
 * 返回的是「条目 id → 请求文件」的映射，以及没用上的请求文件个数。
 */
export function matchRequests(
  entries: ParsedEntry[],
  files: RequestFileMeta[],
): { matched: Map<string, RequestFileMeta>; unmatched: number } {
  const matched = new Map<string, RequestFileMeta>();
  if (files.length === 0) return { matched, unmatched: 0 };

  let cursor = 0;
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.role !== "assistant") continue;
    if (entry.timestamp === null) continue;
    let chosen: RequestFileMeta | null = null;
    while (cursor < files.length) {
      const file = files[cursor];
      if (file.written_at === null || file.written_at <= entry.timestamp) {
        chosen = file;
        cursor += 1;
      } else {
        break;
      }
    }
    if (chosen !== null) matched.set(entry.entry_id, chosen);
  }
  return { matched, unmatched: files.length - cursor };
}

/** 本地时间转紧凑时间戳：`20261102T114049412Z`（毫秒精度） */
function compactTime(at: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return (
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}${pad(at.getUTCMilliseconds(), 3)}Z`
  );
}

/** 紧凑时间戳还原成 ISO 字符串 */
function isoFromCompact(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, milli] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${milli}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}
