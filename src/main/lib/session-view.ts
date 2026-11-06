/**
 * 会话数据的组装：文件 → 页面要的数据。
 *
 * 只有服务端能用（它读文件）。客户端组件只看 `types.ts` 里的形状。
 */
import { statSync } from "node:fs";

import { loadSession } from "./session-cache.ts";
import { listRequestFiles, matchRequests, requestFileSize } from "./request-store.ts";
import { findSessionPath, listSessionMeta, readSessionMeta } from "./session-files.ts";
import { readEntryRaw } from "./session-raw.ts";
import { buildSessionStream } from "./stream.ts";
import type { StreamTurn } from "../../shared/types.ts";
import type { ParsedEntry } from "./session-parse.ts";
import type { EntryDetail, RequestRef, SessionListItem, TimelineEntry } from "../../shared/types.ts";

/** 一次请求返回给页面的内容 */
export interface SessionWindow {
  session: SessionListItem;
  /** 正序的 Turn（最新的一段） */
  turns: StreamTurn[];
  /** 会话前的条目；只有加载到最早时才返回 */
  prelude: StreamTurn | null;
  /** 还有更早的 Turn */
  hasEarlier: boolean;
  /** 这个会话一共多少个 Turn */
  total: number;
  /** 对不上任何助手消息的请求文件数 */
  unmatched_requests: number;
  totals: {
    entries: number;
    messages: number;
    turns: number;
    tools: number;
    requests: number;
    tokens_in: number;
    tokens_out: number;
    cache_read: number;
    cache_write: number;
    cost: number;
  };
  branch: {
    entries: number;
    current: number;
    offCurrent: number;
    forks: number;
    orphans: number;
  };
}

/** 列表页的会话行 */
export function listSessionItems(limit = 500): SessionListItem[] {
  return listSessionMeta(limit).map((meta) => ({
    session_id: meta.session_id,
    cwd: meta.cwd,
    file_path: meta.file_path,
    started_at: meta.started_at,
    last_activity_at: meta.mtime_ms > 0 ? new Date(meta.mtime_ms).toISOString() : null,
    size_bytes: meta.size_bytes,
    first_user_text: meta.first_user_text,
  }));
}

/** 按会话 id 找到列表行 */
export function sessionListItem(sessionId: string): SessionListItem | null {
  const path = findSessionPath(sessionId);
  if (path === null) return null;
  const meta = readSessionMeta(path);
  if (meta === null) return null;
  return {
    session_id: meta.session_id,
    cwd: meta.cwd,
    file_path: meta.file_path,
    started_at: meta.started_at,
    last_activity_at: meta.mtime_ms > 0 ? new Date(meta.mtime_ms).toISOString() : null,
    size_bytes: meta.size_bytes,
    first_user_text: meta.first_user_text,
  };
}

/**
 * 取一个会话的一段展示数据。
 *
 * `before` 是「要更早的 Turn」的界：只返回序号不大于它的 Turn。
 * 页面「加载更早」时带上当前最早那个 Turn 的序号减一，
 * 服务端就只回更早的那一段——大会话不会一次性把几 MB 的行全塞给浏览器。
 */
export async function loadSessionWindow(
  sessionId: string,
  options: { turns?: number; before?: number } = {},
): Promise<SessionWindow | null> {
  const path = findSessionPath(sessionId);
  if (path === null) return null;
  const parsed = await loadSession(path);
  if (parsed === null) return null;

  const files = listRequestFiles(sessionId);
  const { matched, unmatched } = matchRequests(parsed.entries, files);

  const requests: Record<string, RequestRef> = {};
  for (const [entryId, file] of matched) {
    requests[entryId] = {
      id: file.id,
      filename: file.filename,
      path: file.path,
      seq: file.seq,
      written_at: file.written_at,
      size_bytes: requestFileSize(file),
    };
  }

  const entries: TimelineEntry[] = parsed.entries.map((entry) => toTimelineEntry(entry));
  const view = {
    session: sessionListItem(sessionId) ?? fallbackSession(parsed, path),
    entries,
    requests,
  };

  const stream = buildSessionStream(view);
  const size = options.turns ?? 20;
  const before = options.before ?? null;

  // `before` 之前（含）的 Turn 是这一段的范围；再取最后 size 个
  const scoped = before === null ? stream.turns : stream.turns.filter((turn) => (turn.index ?? 0) <= before);
  const start = Math.max(0, scoped.length - size);
  const turns = scoped.slice(start);
  // 取到第一个 Turn（序号 1）时，说明已经到头了，这时才给「会话前」
  const atBeginning = turns.length > 0 && turns[0]?.index === 1;

  return {
    session: view.session,
    turns,
    prelude: atBeginning ? stream.prelude : null,
    hasEarlier: start > 0 || (before !== null && scoped.length > 0),
    total: stream.turns.length,
    unmatched_requests: unmatched,
    totals: {
      entries: parsed.entries.length,
      messages: parsed.aggregates.message_count,
      turns: parsed.aggregates.assistant_count,
      tools: parsed.aggregates.tool_call_count,
      requests: matched.size,
      tokens_in: parsed.aggregates.tokens_in,
      tokens_out: parsed.aggregates.tokens_out,
      cache_read: parsed.aggregates.cache_read,
      cache_write: parsed.aggregates.cache_write,
      cost: parsed.aggregates.cost,
    },
    branch: stream.branch,
  };
}

function fallbackSession(parsed: { session_id: string; cwd: string; started_at: string | null }, path: string): SessionListItem {
  return {
    session_id: parsed.session_id,
    cwd: parsed.cwd,
    file_path: path,
    started_at: parsed.started_at,
    last_activity_at: mtimeIso(path),
    size_bytes: 0,
    first_user_text: null,
  };
}

function toTimelineEntry(entry: ParsedEntry): TimelineEntry {
  return {
    entry_id: entry.entry_id,
    parent_id: entry.parent_id,
    kind: entry.kind,
    role: entry.role,
    timestamp: entry.timestamp,
    entry_index: entry.entry_index,
    text: entry.text,
    thinking: entry.thinking,
    tool_names: entry.tool_calls.map((call) => call.name),
    tool_call_id: entry.tool_call_id,
    tool_name: entry.tool_name,
    is_error: entry.is_error,
    duration_ms: entry.duration_ms,
    usage: entry.usage,
    provider: entry.provider,
    model: entry.model,
    api: entry.api,
    stop_reason: entry.stop_reason,
    thinking_level: entry.thinking_level,
    response_id: entry.response_id,
    payload_bytes: entry.payload_bytes,
  };
}

function mtimeIso(path: string): string | null {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/**
 * 取一条条目的原文（行详情弹窗用）。
 *
 * 解析时把正文截到 2 KB，原文没有留在内存里，所以这里再读一次文件，
 * 按条目 id 找到那一行。
 */
export async function loadEntryDetail(sessionId: string, entryId: string): Promise<EntryDetail | null> {
  const path = findSessionPath(sessionId);
  if (path === null) return null;
  const found = await readEntryRaw(path, entryId);
  if (found === null) return null;

  const message = isObj(found.raw.message) ? found.raw.message : null;
  const role = message !== null && typeof message.role === "string" ? message.role : null;

  let tool: EntryDetail["tool"] = null;
  if (role === "toolResult") {
    const toolCallId = typeof message?.toolCallId === "string" ? message.toolCallId : null;
    const toolName = typeof message?.toolName === "string" ? message.toolName : null;
    const args = toolCallId === null ? null : await findToolArgs(path, toolCallId);
    tool = {
      tool_call_id: toolCallId ?? "",
      tool_name: toolName ?? "",
      is_error: message?.isError === true,
      duration_ms: typeof message?.durationMs === "number" ? message.durationMs : null,
      args,
      result: message?.content ?? null,
    };
  }

  return {
    entry_id: entryId,
    kind: typeof found.raw.type === "string" ? found.raw.type : "unknown",
    role,
    timestamp: typeof found.raw.timestamp === "string" ? found.raw.timestamp : null,
    raw: found.raw,
    tool,
  };
}

/** 在文件里找某个工具调用的参数 */
async function findToolArgs(path: string, toolCallId: string): Promise<unknown> {
  const parsed = await loadSession(path);
  if (parsed === null) return null;
  for (const entry of parsed.entries) {
    if (entry.kind !== "message" || entry.role !== "assistant") continue;
    for (const call of entry.tool_calls) {
      if (call.id !== toolCallId) continue;
      return { preview: call.args_preview, bytes: call.args_bytes };
    }
  }
  return null;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
