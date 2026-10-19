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
