/**
 * 会话文件（JSONL）的完整解析。
 *
 * 文件格式：首行是 `session` 头，其余每行是一个条目。条目类型有
 * `message` / `model_change` / `thinking_level_change` / `compaction` /
 * `branch_summary` / `context_edit` / `label` / `session_info` / `usage` /
 * `custom` 等。`message` 条目里再分 user / assistant / toolResult / system。
 *
 * 解析结果只保留渲染需要的东西：正文截到 2 KB，完整原文不进内存
 * （行详情弹窗会按条目 id 单独再读一次文件）。
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { textOfContent } from "./session-files.ts";

/** 正文摘要最多留多少字节 */
export const TEXT_MAX_BYTES = 2048;

export interface ToolCallRef {
  id: string;
  name: string;
  /** 参数 JSON 的前 500 字符 */
  args_preview: string;
  args_bytes: number;
}

export interface EntryUsage {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost: number | null;
}

export interface ParsedEntry {
  entry_id: string;
  parent_id: string | null;
  /** 条目类型：`message` 或 Pi 的其它条目类型 */
  kind: string;
  /** 消息角色：user / assistant / toolResult / system；其它条目为 null */
  role: string | null;
  timestamp: string | null;
  /** 在文件里的行号（从 0 开始） */
  entry_index: number;
  /** 摘要文本；其它条目是一行说明 */
  text: string | null;
  /** 助手消息里的第一段思考 */
  thinking: string | null;
  /** 助手消息里的工具调用 */
  tool_calls: ToolCallRef[];
  /** toolResult 条目对应的调用 id */
  tool_call_id: string | null;
  tool_name: string | null;
  is_error: boolean;
  duration_ms: number | null;
  usage: EntryUsage | null;
  provider: string | null;
  model: string | null;
  api: string | null;
  stop_reason: string | null;
  thinking_level: string | null;
  response_id: string | null;
  /** 原始条目 JSON 的字节数 */
  payload_bytes: number;
}

export interface SessionAggregates {
  message_count: number;
  assistant_count: number;
  tool_call_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost: number;
}

export interface ParsedSession {
  session_id: string;
  cwd: string;
  version: number | null;
  started_at: string | null;
  parent_session: string | null;
  entries: ParsedEntry[];
  aggregates: SessionAggregates;
}

/** 解析一个会话文件。文件读不了时返回 null。 */
export async function parseSessionFile(filePath: string): Promise<ParsedSession | null> {
  const entries: ParsedEntry[] = [];
  let header: Record<string, unknown> | null = null;
  let index = 0;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // 坏行跳过：文件可能被写了一半
        index += 1;
        continue;
      }
      if (!isObj(parsed)) {
        index += 1;
        continue;
      }
      if (parsed.type === "session" && header === null) {
        header = parsed;
        index += 1;
        continue;
      }
      const entry = toEntry(parsed, index, trimmed.length);
      if (entry !== null) entries.push(entry);
      index += 1;
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }

  return {
    session_id: header !== null && typeof header.id === "string" ? header.id : "",
    cwd: header !== null && typeof header.cwd === "string" ? header.cwd : "",
    version: header !== null && typeof header.version === "number" ? header.version : null,
    started_at: header !== null && typeof header.timestamp === "string" ? header.timestamp : null,
    parent_session:
      header !== null && typeof header.parentSession === "string" ? header.parentSession : null,
    entries,
    aggregates: aggregate(entries),
  };
}

/** 一行条目 → 结构化条目 */
function toEntry(raw: Record<string, unknown>, index: number, rawLength: number): ParsedEntry | null {
  const kind = typeof raw.type === "string" ? raw.type : "unknown";
  const entryId = typeof raw.id === "string" && raw.id !== "" ? raw.id : `#line:${index}`;
  const parentId = typeof raw.parentId === "string" && raw.parentId !== "" ? raw.parentId : null;
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : null;
  const message = isObj(raw.message) ? raw.message : null;
  const role = message !== null && typeof message.role === "string" ? message.role : null;

  const entry: ParsedEntry = {
    entry_id: entryId,
    parent_id: parentId,
    kind,
    role,
    timestamp,
    entry_index: index,
    text: null,
    thinking: null,
    tool_calls: [],
    tool_call_id: null,
    tool_name: null,
    is_error: false,
    duration_ms: null,
    usage: null,
    provider: null,
    model: null,
    api: null,
    stop_reason: null,
    thinking_level: null,
    response_id: null,
    payload_bytes: Buffer.byteLength(rawLength > 0 ? JSON.stringify(raw) : "", "utf8"),
  };

  if (message === null) {
    entry.text = describeEntry(kind, raw);
    return entry;
  }

  if (role === "assistant") {
    entry.text = capText(textOfContent(message.content) ?? "");
    entry.thinking = firstThinking(message.content);
    entry.tool_calls = toolCallsOf(message);
    entry.provider = strOf(message.provider);
    entry.model = strOf(message.model);
    entry.api = strOf(message.api);
    entry.stop_reason = strOf(message.stopReason);
    entry.thinking_level = strOf(message.thinkingLevel);
    entry.response_id = strOf(message.responseId);
    entry.duration_ms = numOf(message.durationMs);
    entry.usage = usageOf(message.usage);
    if (entry.text === "") entry.text = placeholderOfContent(message.content);
    return entry;
  }

  if (role === "toolResult") {
    entry.tool_call_id = strOf(message.toolCallId);
    entry.tool_name = strOf(message.toolName);
    entry.is_error = message.isError === true;
    entry.duration_ms = numOf(message.durationMs);
    entry.text = capText(textOfContent(message.content) ?? "");
    if (entry.text === "") entry.text = entry.is_error ? "（工具失败，没有文字结果）" : "（工具没有文字结果）";
    return entry;
  }

  if (role === "user") {
    entry.text = capText(textOfContent(message.content) ?? "");
    if (entry.text === "") entry.text = "（空消息）";
    return entry;
  }

  if (role === "system") {
    entry.text = systemSummary(message);
    return entry;
  }

  entry.text = capText(textOfContent(message.content) ?? "");
  return entry;
}

/** 助手消息 content 里的 thinking 部分 */
function firstThinking(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!isObj(item) || item.type !== "thinking") continue;
    const value = item.thinking ?? item.text;
    if (typeof value === "string" && value !== "") return capText(value);
  }
  return null;
}

/** 助手消息里的工具调用 */
function toolCallsOf(message: Record<string, unknown>): ToolCallRef[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const calls: ToolCallRef[] = [];
  for (const item of content) {
    if (!isObj(item) || item.type !== "toolCall") continue;
    const id = strOf(item.id);
    if (id === null) continue;
    let args = "{}";
    try {
      args = JSON.stringify(item.arguments ?? {}) ?? "{}";
    } catch {
      args = "{}";
    }
    calls.push({
      id,
      name: strOf(item.name) ?? "",
      args_preview: args.length <= 500 ? args : `${args.slice(0, 500)}…`,
      args_bytes: Buffer.byteLength(args, "utf8"),
    });
  }
  return calls;
}

function usageOf(value: unknown): EntryUsage | null {
  if (!isObj(value)) return null;
  const cost = isObj(value.cost) ? value.cost : null;
  return {
    input: numOf(value.input),
    output: numOf(value.output),
    cache_read: numOf(value.cacheRead),
    cache_write: numOf(value.cacheWrite),
    cost: cost === null ? null : numOf(cost.total),
  };
}

function aggregate(entries: ParsedEntry[]): SessionAggregates {
  const totals: SessionAggregates = {
    message_count: 0,
    assistant_count: 0,
    tool_call_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_write: 0,
    cost: 0,
  };
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    totals.message_count += 1;
    if (entry.role === "assistant") {
      totals.assistant_count += 1;
      totals.tool_call_count += entry.tool_calls.length;
    }
    if (entry.usage === null) continue;
    totals.tokens_in += entry.usage.input ?? 0;
    totals.tokens_out += entry.usage.output ?? 0;
    totals.cache_read += entry.usage.cache_read ?? 0;
    totals.cache_write += entry.usage.cache_write ?? 0;
    totals.cost += entry.usage.cost ?? 0;
  }
  return totals;
}

/** 非 message 条目的一行说明 */
function describeEntry(kind: string, raw: Record<string, unknown>): string | null {
  switch (kind) {
    case "model_change":
      return `模型 → ${strOf(raw.modelId) ?? strOf(raw.model) ?? "?"}`;
    case "thinking_level_change":
      return `思考等级 → ${strOf(raw.thinkingLevel) ?? "?"}`;
    case "compaction":
      return snippet(strOf(raw.summary)) ?? "上下文压缩";
    case "branch_summary":
      return snippet(strOf(raw.summary)) ?? "分支摘要";
    case "context_edit":
      return snippet(strOf(raw.summary)) ?? "上下文编辑";
    case "label":
      return `标签：${strOf(raw.label) ?? strOf(raw.name) ?? "?"}`;
    case "session_info":
      return snippet(strOf(raw.name)) ?? "会话信息";
    case "usage":
      return "用量";
    case "custom":
    case "custom_message":
      return snippet(strOf(raw.text)) ?? snippet(strOf(raw.name)) ?? "自定义条目";
    default:
      return kind;
  }
}

/** 系统消息的正文在 `sections.preamble` 里 */
function systemSummary(message: Record<string, unknown>): string {
  const sections = isObj(message.sections) ? message.sections : null;
  const preamble = sections === null ? null : strOf(sections.preamble);
  if (preamble === null) return "[系统提示]";
  return capText(`[系统提示] ${preamble}`);
}

/** 只有思考 / 工具调用的助手消息：给个能认出来的占位摘要 */
function placeholderOfContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const names: string[] = [];
  let thinking = false;
  for (const item of content) {
    if (!isObj(item)) continue;
    if (item.type === "thinking") thinking = true;
    if (item.type === "toolCall" && typeof item.name === "string") names.push(item.name);
  }
  const bits: string[] = [];
  if (thinking) bits.push("[思考]");
  if (names.length > 0) bits.push(`[工具调用：${names.join(", ")}]`);
  return bits.length === 0 ? null : bits.join(" ");
}

function snippet(text: string | null): string | null {
  if (text === null) return null;
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine === "") return null;
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 120)}…`;
}

/** 按字节截断，不切断多字节字符 */
export function capText(text: string): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= TEXT_MAX_BYTES) return text;
  const head = buffer.subarray(0, TEXT_MAX_BYTES).toString("utf8").replace(/�+$/, "");
  return `${head}…`;
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
