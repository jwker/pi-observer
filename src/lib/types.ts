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

export interface ProbeStatusRow {
  last_seen_at: string | null;
  dropped_count: number;
  queue_depth: number;
  probe_version: string | null;
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

/** 会话文件的读取进度（PRD §9.1） */
export interface JsonlFileRow {
  path: string;
  session_id: string | null;
  size: number;
  mtime_ms: number;
  entry_count: number;
  last_read_at: string | null;
}
