/**
 * 时间线的行模型（纯函数）。
 *
 * 输入是会话文件解析出来的条目，输出按「用户消息」分组的行：
 *
 *   - 一个 Turn = 一条用户消息 + 它之后、下一条用户消息之前的全部条目；
 *   - 第一条用户消息之前的条目归「会话前」（prelude）；
 *   - 当前分支由 `tree.ts` 判断：旁支条目照样返回，但标 `onCurrentBranch=false`，
 *     界面默认隐藏，切「其它分支」时再显示；
 *   - 助手消息行带上对应的 provider 请求标识（文件名的唯一部分），
 *     点开能直接看到去哪儿找那个请求文件。
 *
 * 分页按 Turn 算：`turnWindow(stream, pages, 20)` 返回最近 N 页的正序 Turn，
 * 界面反转后显示。
 */
import { buildMessageTree } from "./tree.ts";
import type { MessageTree } from "./tree.ts";
import type { MessageIndexRow, RequestRef, TimelineEntry } from "./types.ts";

export type StreamCategory = "msg" | "session" | "model" | "tool";

export type StreamRowKind = "user" | "assistant" | "tool" | "note";

export interface StreamRow {
  key: string;
  kind: StreamRowKind;
  category: StreamCategory;
  at: string | null;
  label: string;
  text: string | null;
  thinking: string | null;
  entryId: string | null;
  parentId: string | null;
  entryIndex: number;
  payloadBytes: number;
  onCurrentBranch: boolean;
  branchStart: boolean;
  forkPoint: boolean;
  orphan: boolean;
  /** 助手行上的工具名 */
  toolNames: string[];
  toolCallId: string | null;
  toolName: string | null;
  toolError: boolean;
  durationMs: number | null;
  /** 对应的 provider 请求文件标识；没有就 null */
  requestId: string | null;
  requestPath: string | null;
  requestBytes: number | null;
  requestWrittenAt: string | null;
}

export interface StreamTurnStats {
  toolCount: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface StreamTurn {
  key: string;
  kind: "turn" | "prelude";
  /** 用户 Turn 的序号，从 1 开始；prelude 为 null */
  index: number | null;
  summary: string;
  startedAt: string | null;
  endedAt: string | null;
  /** 正序：同一 Turn 内从旧到新 */
  rows: StreamRow[];
  stats: StreamTurnStats;
  onCurrentBranch: boolean;
}

export interface SessionStream {
  /** 第一条用户消息之前的条目 */
  prelude: StreamTurn | null;
  /** 用户 Turn，正序（旧 → 新） */
  turns: StreamTurn[];
  branch: {
    entries: number;
    current: number;
    offCurrent: number;
    forks: number;
    orphans: number;
  };
}

export interface TurnWindow {
  /** 正序的一页；界面反转后显示 */
  turns: StreamTurn[];
  /** 只有加载到最早一页时才返回 prelude */
  prelude: StreamTurn | null;
  hasEarlier: boolean;
  total: number;
  pageSize: number;
  loaded: number;
}

/** 把条目转成树需要的索引行 */
function indexRows(entries: TimelineEntry[]): MessageIndexRow[] {
  return entries.map((entry) => ({
    entry_id: entry.entry_id,
    parent_id: entry.parent_id,
    kind: entry.kind,
    role: entry.role,
    timestamp: entry.timestamp,
    entry_index: entry.entry_index,
    summary: entry.text,
    payload_bytes: entry.payload_bytes,
  }));
}

/** 把一个条目变成一行 */
function toRow(
  entry: TimelineEntry,
  tree: MessageTree,
  requests: Record<string, RequestRef>,
): StreamRow {
  const node = tree.byId.get(entry.entry_id);
  const request = requests[entry.entry_id] ?? null;

  const row: StreamRow = {
    key: entry.entry_id,
    kind: "note",
    category: "session",
    at: entry.timestamp,
    label: "",
    text: entry.text,
    thinking: entry.thinking,
    entryId: entry.entry_id,
    parentId: entry.parent_id,
    entryIndex: entry.entry_index,
    payloadBytes: entry.payload_bytes,
    onCurrentBranch: node?.onCurrentBranch ?? true,
    branchStart: node?.branchStart ?? false,
    forkPoint: node?.forkPoint ?? false,
    orphan: node?.orphan ?? false,
    toolNames: entry.tool_names,
    toolCallId: entry.tool_call_id,
    toolName: entry.tool_name,
    toolError: entry.is_error,
    durationMs: entry.duration_ms,
    requestId: request?.id ?? null,
    requestPath: request?.path ?? null,
    requestBytes: request?.size_bytes ?? null,
    requestWrittenAt: request?.written_at ?? null,
  };

  if (entry.kind !== "message") {
    row.kind = "note";
    row.category = entry.kind === "model_change" || entry.kind === "thinking_level_change" ? "model" : "session";
    row.label = entry.kind;
    return row;
  }

  if (entry.role === "user") {
    row.kind = "user";
    row.category = "msg";
    row.label = "你";
    return row;
  }

  if (entry.role === "assistant") {
    row.kind = "assistant";
    row.category = "msg";
    row.label = "助手";
    return row;
  }

  if (entry.role === "toolResult") {
    row.kind = "tool";
    row.category = "tool";
    row.label = entry.tool_name ?? "工具";
    return row;
  }

  row.kind = "note";
  row.category = "session";
  row.label = entry.role ?? "条目";
  return row;
}

/** 按用户消息切 Turn */
export function buildSessionStream(view: {
  entries: TimelineEntry[];
  requests: Record<string, RequestRef>;
}): SessionStream {
  const tree = buildMessageTree(indexRows(view.entries));
  const requests = view.requests;

  const turns: StreamTurn[] = [];
  let current: StreamTurn | null = null;
  let preludeRows: StreamRow[] = [];

  for (const entry of view.entries) {
    const row = toRow(entry, tree, requests);
    const startsTurn = entry.kind === "message" && entry.role === "user";
    if (startsTurn) {
      current = {
        key: `turn:${entry.entry_id}`,
        kind: "turn",
        index: turns.length + 1,
        summary: entry.text ?? "（空消息）",
        startedAt: entry.timestamp,
        endedAt: entry.timestamp,
        rows: [row],
        stats: emptyStats(),
        onCurrentBranch: row.onCurrentBranch,
      };
      turns.push(current);
      continue;
    }
    if (current === null) {
      preludeRows.push(row);
      continue;
    }
    current.rows.push(row);
    if (entry.timestamp !== null) current.endedAt = entry.timestamp;
    if (entry.kind === "message" && entry.role === "toolResult") {
      current.stats.toolCount += 1;
      if (entry.is_error) current.stats.toolErrors += 1;
    }
    if (entry.kind === "message" && entry.role === "assistant" && entry.usage !== null) {
      current.stats.tokensIn += entry.usage.input ?? 0;
      current.stats.tokensOut += entry.usage.output ?? 0;
      current.stats.cacheRead += entry.usage.cache_read ?? 0;
      current.stats.cacheWrite += entry.usage.cache_write ?? 0;
      current.stats.cost += entry.usage.cost ?? 0;
    }
  }

  const prelude: StreamTurn | null =
    preludeRows.length === 0
      ? null
      : {
          key: "prelude",
          kind: "prelude",
          index: null,
          summary: "会话前",
          startedAt: preludeRows[0]?.at ?? null,
          endedAt: preludeRows[preludeRows.length - 1]?.at ?? null,
          rows: preludeRows,
          stats: emptyStats(),
          onCurrentBranch: preludeRows.every((row) => row.onCurrentBranch),
        };

  return {
    prelude,
    turns,
    branch: {
      entries: tree.total,
      current: tree.currentBranch.size,
      offCurrent: tree.total - tree.currentBranch.size,
      forks: tree.forkPoints,
      orphans: tree.orphans,
    },
  };
}

function emptyStats(): StreamTurnStats {
  return {
    toolCount: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
}

/** 取最近 `pages * pageSize` 个 Turn（正序）；prelude 只在取到最早时返回 */
export function turnWindow(stream: SessionStream, pages: number, pageSize: number): TurnWindow {
  const total = stream.turns.length;
  const keep = Math.min(total, Math.max(1, pages) * pageSize);
  const start = Math.max(0, total - keep);
  const turns = stream.turns.slice(start);
  return {
    turns,
    prelude: start === 0 ? stream.prelude : null,
    hasEarlier: start > 0,
    total,
    pageSize,
    loaded: turns.length,
  };
}
