/**
 * 探针 ↔ 看板服务的线上契约（单一来源）。
 *
 * 引用方：`ext/index.ts`（探针，由 Pi 用 jiti 加载）与 `src/lib/ingest.ts`（服务端）。
 * 本文件必须保持「零依赖、纯类型与常量」，不 import 任何 node: 内置模块或框架，
 * 因为它同时会被 jiti（Pi 内）与 Next（构建期）加载。
 *
 * v3 起内容只有一条路径：会话文件 → `messages.payload`。事件只补文件里没有的操作信息，
 * `turns` / `tool_calls` 只留标量、时间与指向 `messages` 的引用，不再复制正文。
 */

/** 协议版本；探针与服务不一致时服务端拒绝整批（见 ingest.ts） */
export const PROBE_PROTOCOL_VERSION = 3;

/** 探针在会话开始时上报自己的版本，便于在看板上判断探针是否过期 */
export const PROBE_VERSION = "0.3.0";

export type EventLayer = "session" | "agent" | "tool" | "provider";

export type SessionState = "active" | "idle" | "ended";
export type DataSource = "live" | "backfill" | "merged";
export type RunOutcome = "completed" | "aborted" | "error";

/** 会话元信息：来自 `session_start` + `ctx.sessionManager` */
export interface SessionRecord {
  kind: "session";
  session_id: string;
  cwd: string;
  file_path: string | null;
  parent_session: string | null;
  version: number | null;
  name: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  state: SessionState;
  source: DataSource;
}

/** 一次运行的边界：`agent_start` → `agent_settled` */
export interface RunRecord {
  kind: "run";
  session_id: string;
  run_seq: number;
  started_at: string | null;
  ended_at: string | null;
  outcome: RunOutcome | null;
}

/**
 * 时间线事件；`event_id` 由探针生成，服务端按它幂等。
 * `run_seq` / `turn_index` 用于分组：`turnIndex` 每次运行归零，所以需要运行序号配合。
 *
 * 事件不携带消息正文：正文统一由会话文件同步进 `messages.payload`。
 */
export interface EventRecord {
  kind: "event";
  event_id: string;
  session_id: string;
  layer: EventLayer;
  event_type: string;
  payload: unknown;
  occurred_at: string | null;
  run_seq: number | null;
  turn_index: number | null;
}

/**
 * Turn 的元信息；正文只通过 `message_entry_id` 指向 `messages`。
 * token / 缓存 / 成本来自 `turn_end` 钩子给的助手消息 usage。
 */
export interface TurnRecord {
  kind: "turn";
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
  cache_read: number | null;
  cache_write: number | null;
  cost: number | null;
}

/**
 * 一次模型请求（`before_provider_request` → `after_provider_response`）。
 * `(session_id, request_seq)` 是持久键：请求开始时写一次，响应到达时用同一序号再写一次，
 * 服务端按 `COALESCE(excluded.x, table.x)` 合并，所以更新记录里的 `payload` / `payload_bytes` 为 null。
 */
export interface RequestRecord {
  kind: "request";
  session_id: string;
  request_seq: number;
  provider: string | null;
  api: string | null;
  model: string | null;
  /** 已脱敏、超限已截断的 payload；响应更新时为 null */
  payload: unknown;
  /** 脱敏前原始 payload 的序列化字节数；响应更新时为 null */
  payload_bytes: number | null;
  payload_truncated: boolean | null;
  status: number | null;
  /** 已脱敏的响应头；请求开始时为 null */
  response_headers: unknown;
  correlation: "serial_assumed";
  created_at: string;
  /** 请求发生时所在的运行 / Turn；用于关联 turns 的 token 与成本 */
  run_seq: number | null;
  turn_index: number | null;
}

/**
 * 工具调用；`tool_call_id` 是持久键，执行中按同一行 upsert。
 *
 * 参数与结果不再随记录传输：
 *   - `entry_id` 指向助手消息条目，参数在该条目 content 的 `toolCall.arguments` 里；
 *   - `result_entry_id` 指向 toolResult 条目，结果就是那条消息。
 * 探针不知道条目 id（那是文件的产物），所以这两个字段由文件同步器补写。
 */
export interface ToolCallRecord {
  kind: "tool_call";
  tool_call_id: string;
  session_id: string;
  parent_tool_call_id: string | null;
  tool_name: string;
  is_error: boolean;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  /** 工具执行时所在的运行 / Turn（M3-4 起写入，用于按 Turn 筛选与关联） */
  run_seq: number | null;
  turn_index: number | null;
  /** 助手消息条目 id（文件同步器补写） */
  entry_id: string | null;
  /** toolResult 条目 id（文件同步器补写） */
  result_entry_id: string | null;
}

export type IngestRecord =
  | SessionRecord
  | RunRecord
  | EventRecord
  | TurnRecord
  | ToolCallRecord
  | RequestRecord;

/** 一批推送。`dropped_count` / `queue_depth` 是探针侧队列的自我报告（PRD §7.4） */
export interface IngestBatch {
  protocol: number;
  probe_version: string;
  dropped_count: number;
  queue_depth: number;
  records: IngestRecord[];
}

export interface IngestResponse {
  ok: true;
  accepted: number;
  /** 各表的落库条数，便于探针自检 */
  applied: Record<string, number>;
  /** 被丢弃的记录种类与原因（形状不合法、超出体积等） */
  rejected: number;
}
