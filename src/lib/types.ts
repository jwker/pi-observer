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
  /** 来自助手消息 usage.cacheRead / cacheWrite；旧数据或没有 usage 时为 null */
  cache_read: number | null;
  cache_write: number | null;
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

/** 工具列表的一行（PRD §11.2 视图三）：不带完整参数 / 结果，点进详情再取 */
export interface ToolCallIndexRow extends ToolCallRow {
  parent_tool_call_id: string | null;
  run_seq: number | null;
  turn_index: number | null;
  /** 助手消息条目（参数所在） */
  entry_id: string | null;
  /** toolResult 条目（结果所在） */
  result_entry_id: string | null;
  args_bytes: number;
  result_bytes: number;
  /** 参数 JSON 的前 500 字符，用于列表摘要；完整参数在详情页 */
  args_preview: string | null;
  /** 结果里的第一段文本（前 500 字符），没有文本时为空 */
  result_preview: string | null;
}

/** 工具详情：参数与结果已解析（来自 messages，按 entry_id / result_entry_id join） */
export interface ToolCallDetail extends ToolCallIndexRow {
  args: unknown;
  result: unknown;
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
 * 条目的「索引形状」：不含 payload，只带树结构与摘要需要的字段。
 *
 * 它同时是 `tree.ts` 的输入类型与 `stream.ts` 建行模型时的输入；
 * 完整 payload 在行详情弹窗里按需取（`getMessageDetail`）。
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

/** 单条条目的全文（行详情弹窗按需取） */
export interface MessageDetail {
  entry_id: string;
  parent_id: string | null;
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
 * 时间线用的条目行（单页重构 R2）：带正文与思考摘要，但不带完整 payload。
 *
 * 为什么不直接复用 `MessageIndexRow`：时间线要显示比树标签更长的正文，还要把
 * 助手消息里的 thinking 单独拿出来（思考开关靠它）。完整正文仍在详情弹窗里按需取。
 */
export interface TimelineMessageRow {
  entry_id: string;
  parent_id: string | null;
  kind: string;
  role: string | null;
  timestamp: string | null;
  entry_index: number;
  /** `messages.text` 的正文摘要（回填时已截到 2 KB） */
  text: string | null;
  /** 助手消息里的第一段 thinking（截到 2 KB）；其它条目为 null */
  thinking: string | null;
  payload_bytes: number;
}

/**
 * 单页时间线一次取到的原始数据（R2）。分页、分组、行排序在 `stream.ts` 里做，
 * 这里只负责把库里的行按会话取全。
 *
 * `totals` 是库里真实行数；某个数组短于总数时，说明被 `limit` 截断，界面要如实说明。
 */
export interface SessionStreamData {
  session: SessionRow;
  messages: TimelineMessageRow[];
  turns: TurnRow[];
  events: EventRow[];
  tools: ToolCallIndexRow[];
  requests: RequestIndexRow[];
  totals: {
    messages: number;
    turns: number;
    events: number;
    tools: number;
    requests: number;
  };
}

export type RowDetailKind = "message" | "tool" | "request" | "event";

/**
 * 行详情弹窗一次取到的内容（R3）。
 *
 * 为什么用「一个袋子里有什么就放什么」而不是给四类行各开一个接口：弹窗只需要
 * 当前行对应的主对象，加上能从钩子载荷里确定关联到的条目 / 请求 / 工具。返回结构
 * 固定，客户端不用按 kind 猜字段。
 */
export interface RowDetailData {
  kind: RowDetailKind;
  /** 文件条目（消息、系统条目、工具结果条目） */
  message: MessageDetail | null;
  /** 工具调用（含完整参数与结果） */
  tool: ToolCallDetail | null;
  /** 请求（含脱敏 payload 与响应头） */
  request: RequestDetail | null;
  /** 单条钩子事件 */
  event: EventRow | null;
  /** 与这一行关联的钩子事件；按 id 去重 */
  relatedEvents: EventRow[];
  /** 钩子载荷指向的工具；事件详情用 */
  relatedTools: ToolCallDetail[];
  /** 钩子载荷指向的请求；事件详情用 */
  relatedRequest: RequestDetail | null;
  /** 工具参数 / 结果所在的文件条目；工具详情的原始 JSON 用 */
  relatedMessages: MessageDetail[];
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
