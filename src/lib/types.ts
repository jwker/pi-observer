/**
 * 页面用的数据形状（纯类型，不 import 任何东西）。
 *
 * 单独成文件是为了让客户端组件可以安全地 `import type`，
 * 不会把 `node:fs` 之类的东西带进浏览器包。
 */
import type { StreamTurn } from "./stream.ts";

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
 *
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

/**
 * 单个会话的一段展示数据（页面的数据形状）。
 *
 * Turn 已经按「用户消息」分好组，行也已经排好序：
 * 服务端把这一段算好再给浏览器，浏览器不再重复算一遍。
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
