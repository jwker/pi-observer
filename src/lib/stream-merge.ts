/**
 * 合并实时刷新带回来的数据。
 *
 * 服务端的实时刷新只回最近的一段（最近的消息 / Turn / 事件 / 工具 / 请求），
 * 这里把它和客户端已有的数据合起来：同一项以新的为准，新的追加进去，
 * 旧的一律保留。这样传输量只和「最近发生了什么」有关，和会话有多长无关。
 */

import type {
  EventRow,
  MessageRow,
  RequestIndexRow,
  SessionStreamData,
  TimelineMessageRow,
  ToolCallIndexRow,
  TurnRow,
} from "./types.ts";

function mergeBy<T>(previous: T[], next: T[], key: (item: T) => string, sort: (a: T, b: T) => number): T[] {
  const merged = new Map<string, T>();
  for (const item of previous) merged.set(key(item), item);
  for (const item of next) merged.set(key(item), item);
  return [...merged.values()].sort(sort);
}

const byIndex = (a: TimelineMessageRow, b: TimelineMessageRow): number => a.entry_index - b.entry_index;
const byTurn = (a: TurnRow, b: TurnRow): number =>
  a.run_seq - b.run_seq || a.turn_index - b.turn_index;
const byEventId = (a: EventRow, b: EventRow): number => a.id - b.id;
const byTool = (a: ToolCallIndexRow, b: ToolCallIndexRow): number =>
  (a.started_at ?? "").localeCompare(b.started_at ?? "");
const byRequest = (a: RequestIndexRow, b: RequestIndexRow): number => b.request_seq - a.request_seq;

/**
 * 把实时窗口合并进已有数据。
 *
 * `next` 是服务端刚发来的那一段，`previous` 是客户端手上的全部。
 */
export function mergeStreamData(previous: SessionStreamData, next: SessionStreamData): SessionStreamData {
  return {
    session: next.session,
    messages: mergeBy(previous.messages, next.messages, (m) => m.entry_id, byIndex),
    turns: mergeBy(previous.turns, next.turns, (t) => String(t.id), byTurn),
    events: mergeBy(previous.events, next.events, (e) => String(e.id), byEventId),
    tools: mergeBy(previous.tools, next.tools, (t) => t.tool_call_id, byTool),
    requests: mergeBy(previous.requests, next.requests, (r) => String(r.request_seq), byRequest),
    totals: {
      messages: Math.max(previous.totals.messages, next.totals.messages),
      turns: Math.max(previous.totals.turns, next.totals.turns),
      events: Math.max(previous.totals.events, next.totals.events),
      tools: Math.max(previous.totals.tools, next.totals.tools),
      requests: Math.max(previous.totals.requests, next.totals.requests),
    },
  };
}

/** 首屏全量数据也按同一套规则整理一次，保证顺序稳定。 */
export function normalizeStreamData(data: SessionStreamData): SessionStreamData {
  return mergeStreamData(
    {
      ...data,
      messages: [],
      turns: [],
      events: [],
      tools: [],
      requests: [],
    },
    data,
  );
}

export type { MessageRow };
