/**
 * 探针 ↔ 看板服务的线上契约（单一来源）。
 *
 * 引用方：`ext/index.ts`（探针，由 Pi 用 jiti 加载）与 `src/lib/ingest.ts`（服务端）。
 * 本文件必须保持「零依赖、纯类型与常量」，不 import 任何 node: 内置模块或框架，
 * 因为它同时会被 jiti（Pi 内）与 Next（构建期）加载。
 */

/** 协议版本；探针与服务不一致时服务端拒绝整批（见 ingest.ts） */
export const PROBE_PROTOCOL_VERSION = 2;

/** 探针在会话开始时上报自己的版本，便于在看板上判断探针是否过期 */
export const PROBE_VERSION = "0.2.0";

export type EventLayer = "session" | "agent" | "turn" | "message" | "tool" | "provider";

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
 * `run_seq` / `turn_index` 用于时间线分组：`turnIndex` 每次运行归零，所以需要运行序号配合。
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
 * 流式正文的进度快照（PRD §7.3 / D4）。
 * 同一个 `(session_id, run_seq, turn_index)` 复用同一行，因此不会随 500 ms 心跳无限增长。
 */
export interface ProgressRecord {
  kind: "progress";
  session_id: string;
  run_seq: number;
  turn_index: number;
  text: string;
  update_count: number;
  started_at: string | null;
}

/** Turn 终态；`message_entry_id` 是持久键（PRD §8.3） */
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
  assistant_message: unknown;
  tool_results: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
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

/** 工具调用；`tool_call_id` 是持久键，执行中按同一行 upsert */
export interface ToolCallRecord {
  kind: "tool_call";
  tool_call_id: string;
  session_id: string;
  parent_tool_call_id: string | null;
  tool_name: string;
  args: unknown;
  result: unknown;
  partial_result: unknown;
  is_error: boolean;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export type IngestRecord =
  | SessionRecord
  | RunRecord
  | EventRecord
  | ProgressRecord
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

/** 进度快照的确定性主键，保证同一 (会话, 运行, Turn) 只有一行 */
export function progressEventId(sessionId: string, runSeq: number, turnIndex: number): string {
  return `progress:${sessionId}:${runSeq}:${turnIndex}`;
}

/** 事件层 → 事件名前缀的兜底映射（探针未显式给层时用） */
export function layerOf(eventType: string): EventLayer {
  if (eventType.startsWith("session_")) return "session";
  if (eventType.startsWith("agent_")) return "agent";
  if (eventType.startsWith("turn_")) return "turn";
  if (eventType.startsWith("message_")) return "message";
  if (eventType.startsWith("tool_")) return "tool";
  return "provider";
}
