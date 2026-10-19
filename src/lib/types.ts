/**
 * 看板库的行类型（纯类型，不 import 任何东西）。
 * 单独成文件是为了让客户端组件可以安全地 `import type`，不会把 `node:sqlite` 带进浏览器包。
 */

export interface SessionRow {
  session_id: string;
  cwd: string;
  file_path: string | null;
  parent_session: string | null;
  name: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  message_count: number;
  turn_count: number;
  tool_call_count: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  state: string;
  source: string;
  last_reconciled_at: string | null;
}

export interface EventRow {
  id: number;
  event_id: string;
  session_id: string;
  layer: string;
  event_type: string;
  run_seq: number | null;
  turn_index: number | null;
  payload: unknown;
  occurred_at: string | null;
  received_at: string;
}

export interface TurnRow {
  id: number;
  session_id: string;
  run_seq: number;
  turn_index: number;
  message_entry_id: string;
  started_at: string | null;
  ended_at: string | null;
  stop_reason: string | null;
  thinking_level: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost: number | null;
}

export interface ToolCallRow {
  tool_call_id: string;
  session_id: string;
  tool_name: string;
  is_error: number;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
}

/**
 * 请求列表的一行（PRD §11.2 视图二）：不带 payload / headers，正文点开详情再取。
 * token 与成本来自同一 `(session_id, run_seq, turn_index)` 的 turn，没有关联 Turn 时为 null。
 */
export interface RequestIndexRow {
  id: number;
  session_id: string;
  request_seq: number;
  provider: string | null;
  api: string | null;
  model: string | null;
  payload_bytes: number;
  payload_truncated: number;
  status: number | null;
  created_at: string;
  run_seq: number | null;
  turn_index: number | null;
  /** `response_headers` 的字节数，用于列表上判断有没有拿到响应头 */
  response_headers_bytes: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost: number | null;
}

/** 请求详情：payload 与响应头已脱敏，解析成对象；usage 来自关联 Turn 的助手消息 */
export interface RequestDetail extends RequestIndexRow {
  correlation: string;
  payload: unknown;
  response_headers: unknown;
  turn_started_at: string | null;
  turn_ended_at: string | null;
  turn_stop_reason: string | null;
  /** 助手消息里的 `usage`（含 cacheRead / cacheWrite 与 cost 明细）；没有关联 Turn 时为 null */
  turn_usage: unknown;
}

export interface ProbeStatusRow {
  last_seen_at: string | null;
  dropped_count: number;
  queue_depth: number;
  probe_version: string | null;
}

/** 会话已有数据的最大序号；探针在本地游标缺失时用它种子化（schema v3 / M3-3） */
export interface SessionCursorRow {
  request_seq_max: number;
  run_seq_max: number;
}

/** 会话文件里的一条条目（PRD §8.2 / §9.1）。消息树从 `parent_id` 渲染 */
export interface MessageRow {
  id: number;
  session_id: string;
  entry_id: string;
  parent_id: string | null;
  kind: string;
  role: string | null;
  timestamp: string | null;
  entry_index: number;
  text: string | null;
  payload: unknown;
}

/**
 * 消息树的条目索引（PRD §11.2）：不含 payload，`summary` 截断到 200 字符只够树标签用。
 * 全文与原始条目在点击节点时按需取，见 `MessageDetail`。
 */
export interface MessageIndexRow {
  entry_id: string;
  parent_id: string | null;
  kind: string;
  role: string | null;
  timestamp: string | null;
  entry_index: number;
  summary: string | null;
  /** `payload` 的字节数 */
  payload_bytes: number;
}

/** 单条条目的全文（点击树节点时按需取） */
export interface MessageDetail {
  entry_id: string;
  kind: string;
  role: string | null;
  timestamp: string | null;
  entry_index: number;
  /** 完整摘要：`message` 条目是正文，其他类型是一行说明（回填时截到 2 KB） */
  text: string | null;
  /** 原始条目 JSON；超过上限时是 `{"truncated":true,"bytes":N}` */
  payload: unknown;
  payload_bytes: number;
}

/**
 * 会话列表的一行：会话本身 + 首条用户消息摘要。
 * 会话文件头部没有会话名（实测只有 cwd / id / timestamp / type / version），
 * 所以列表里的「摘要」只能取这一会话的第一条用户消息（PRD §11.1）。
 */
export interface SessionListItem extends SessionRow {
  first_user_text: string | null;
}

/** 列表页概览条（PRD §11.1）。「今日」按服务器本地时区的今天 0 点算 */
export interface OverviewStats {
  events_today: number;
  tokens_in_today: number;
  tokens_out_today: number;
  cost_today: number;
  /** 探针累计丢弃（不是今日） */
  dropped_total: number;
  unreconciled_sessions: number;
  last_reconciled_at: string | null;
}

/** 会话文件的读取进度（PRD §9.1） */
export interface JsonlFileRow {
  path: string;
  session_id: string | null;
  size: number;
  mtime_ms: number;
  entry_count: number;
  last_read_at: string | null;
}
