/**
 * 会话解析结果的内存缓存。
 *
 * 没有数据库，代价是每次打开会话都要重新读文件、重新解析。
 * 一个会话文件可能几十 MB，重复解析既慢又费 CPU，所以这里按
 * 「路径 + 修改时间 + 大小」缓存解析结果，文件变了就重新解析。
 *
 * 缓存只放最近几个会话：解析结果常驻内存，太多会把内存吃满。
 */
import { statSync } from "node:fs";

import { parseSessionFile, type ParsedSession } from "./session-parse.ts";

interface CacheEntry {
  mtime_ms: number;
  size: number;
  parsed: ParsedSession;
}

/** 最多缓存几个会话 */
const MAX_ENTRIES = 3;

const cache = new Map<string, CacheEntry>();

/**
 * 取一个会话的解析结果。文件变了就重新解析。
 *
 * 解析失败（文件被删、不是合法 JSONL）时返回 null，并把失败结果也缓存住，
 * 免得每次刷新都重试一遍。
 */
export async function loadSession(filePath: string): Promise<ParsedSession | null> {
  let mtime = 0;
  let size = 0;
  try {
    const stat = statSync(filePath);
    mtime = stat.mtimeMs;
    size = stat.size;
  } catch {
    cache.delete(filePath);
    return null;
  }

  const hit = cache.get(filePath);
  if (hit !== undefined && hit.mtime_ms === mtime && hit.size === size) {
    // 命中就挪到队尾（最近用过）
    cache.delete(filePath);
    cache.set(filePath, hit);
    return hit.parsed;
  }

  const parsed = await parseSessionFile(filePath);
  if (parsed === null) return null;

  cache.delete(filePath);
  cache.set(filePath, { mtime_ms: mtime, size, parsed });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  return parsed;
}

/** 清空缓存（设置页的「重新读取」用不到，但测试需要） */
export function clearSessionCache(): void {
  cache.clear();
}
