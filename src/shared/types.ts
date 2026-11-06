/**
 * 主进程与渲染进程共用的数据形状。
 *
 * 这个文件不 import 任何东西——尤其不能 import `node:*`，
 * 否则渲染进程（浏览器环境）会被带进 Node 模块。
 */

/** 会话列表里的一行 */
export interface SessionListItem {
  session_id: string;
  cwd: string;
  file_path: string;
  /** 会话头里的创建时间 */
  started_at: string | null;
  /** 文件最后修改时间；这是「最后活动」的唯一依据 */
  last_activity_at: string | null;
  size_bytes: number;
  /** 第一条用户消息的摘要；列表里当会话名用 */
  first_user_text: string | null;
}

/**
 * 条目的「索引形状」：不含正文，只带树结构与摘要需要的字段。
 * 它是 `tree.ts` 的输入类型：树只需要知道条目之间的父子关系。
 */
export interface MessageIndexRow {
  entry_id: string;
  parent_id: string | null;
  kind: string;
  role: string | null;
  timestamp: string | null;
  entry_index: number;
  summary: string | null;
  /** 原始条目的字节数 */
  payload_bytes: number;
}

/** 一次 provider 请求的引用（只有标识与路径，没有正文） */
export interface RequestRef {
  /** 唯一标识 = 文件名（不含扩展名） */
  id: string;
  filename: string;
  path: string;
  seq: number;
  written_at: string | null;
  size_bytes: number | null;
}

/** 时间线上的一个条目（会话文件里的一行） */
export interface TimelineEntry {
  entry_id: string;
  parent_id: string | null;
  kind: string;
  role: string | null;
  timestamp: string | null;
  entry_index: number;
  text: string | null;
  thinking: string | null;
  tool_names: string[];
  tool_call_id: string | null;
  tool_name: string | null;
  is_error: boolean;
  duration_ms: number | null;
  usage: {
    input: number | null;
    output: number | null;
    cache_read: number | null;
    cache_write: number | null;
    cost: number | null;
  } | null;
  provider: string | null;
  model: string | null;
  api: string | null;
  stop_reason: string | null;
  thinking_level: string | null;
  response_id: string | null;
  payload_bytes: number;
}

/** 顶部筛选的分类 */
export type StreamCategory = "msg" | "session" | "model" | "tool";

export type StreamRowKind = "user" | "assistant" | "tool" | "note";

/** 时间线的一行 */
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

/** 一个用户 Turn：一条用户消息 + 它之后、下一条用户消息之前的全部条目 */
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

/** 一个会话的全部 Turn（正序） */
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

/** 一页 Turn（「加载更早」用） */
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

/**
 * 单个会话的一段展示数据（页面的数据形状）。
 *
 * Turn 已经按「用户消息」分好组，行也已经排好序：主进程把这一段算好
 * 通过 IPC 交给渲染进程，渲染进程不再重复算一遍。
 */
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
    /** 模型 Turn 数：一条助手消息 = 一个 Turn */
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

/** 行详情：会话文件里的一条条目 */
export interface EntryDetail {
  entry_id: string;
  kind: string;
  role: string | null;
  timestamp: string | null;
  /** 原始条目 JSON */
  raw: unknown;
  /** 工具参数与结果（工具相关的条目才有） */
  tool: {
    tool_call_id: string;
    tool_name: string;
    is_error: boolean;
    duration_ms: number | null;
    args: unknown;
    result: unknown;
  } | null;
}

/** IPC 调用的返回形状：失败时带一句能显示给人看的话 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };
