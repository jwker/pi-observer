"use client";

import { useEffect, useRef, useState } from "react";

import { clockTime, dateTime, formatBytes, formatDuration, formatTokens, shortId } from "@/lib/format.ts";
import type { StreamRow } from "@/lib/stream.ts";
import type {
  EventRow,
  MessageDetail,
  RequestDetail,
  RowDetailData,
  ToolCallDetail,
} from "@/lib/types.ts";

export interface DetailTarget {
  sessionId: string;
  row: StreamRow;
}

interface RowDetailModalProps {
  target: DetailTarget;
  onClose: () => void;
}

type Tab = "content" | "raw" | "related";

/**
 * 每行「详情」弹窗（R3）。
 *
 * 时间线只带摘要；正文、思考、工具参数 / 结果、请求体与原始 JSON 都在打开时按需取。
 * 文件条目在标题和页脚都标「来自文件」，钩子事件标「钩子事件」。
 */
export function RowDetailModal({ target, onClose }: RowDetailModalProps) {
  const { sessionId, row } = target;
  const kind = detailKind(row);
  const id = detailId(row);
  const [detail, setDetail] = useState<RowDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("content");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (kind === null || id === null) {
      setLoading(false);
      setError("这一行没有可取的详情。");
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setLoading(true);
    setError(null);
    setTab("content");

    const params = new URLSearchParams({ session: sessionId, kind, id });
    if (row.relatedEventIds.length > 0) params.set("related", row.relatedEventIds.join(","));
    fetch(`/api/detail?${params.toString()}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((json: { ok?: boolean; detail?: RowDetailData; error?: string }) => {
        if (json.detail) {
          setDetail(json.detail);
          setError(null);
        } else {
          setError(json.error ?? "取不到这一行的详情。");
        }
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("取不到这一行的详情。看板服务可能已经断开。");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [sessionId, kind, id, row.relatedEventIds]);

  useEffect(() => {
    document.body.classList.add("modal-open");
    panelRef.current?.focus();
    return () => document.body.classList.remove("modal-open");
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const fromFile = row.fromFile;
  const sourceLabel = fromFile ? "来自文件" : kind === "request" ? "钩子记录" : "钩子事件";
  const title = modalTitle(row);
  const relatedCount =
    (detail?.relatedEvents.length ?? 0) +
    (detail?.relatedTools.length ?? 0) +
    (detail !== null && detail.relatedRequest !== null ? 1 : 0);

  return (
    <div className="modal" role="presentation">
      <div className="modal-backdrop" onClick={onClose} />
      <div
        className="modal-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="行详情"
        tabIndex={-1}
      >
        <div className="modal-head">
          <span className={fromFile ? "badge violet" : "badge warn"}>{sourceLabel}</span>
          <h2>{title}</h2>
          <button className="btn ghost x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <DetailMeta row={row} detail={detail} />

        <div className="modal-body">
          <div className="tabs">
            <button className={tab === "content" ? "on" : ""} onClick={() => setTab("content")}>
              内容
            </button>
            <button className={tab === "raw" ? "on" : ""} onClick={() => setTab("raw")}>
              原始 JSON
            </button>
            <button className={tab === "related" ? "on" : ""} onClick={() => setTab("related")}>
              关联{relatedCount > 0 ? ` · ${relatedCount}` : ""}
            </button>
          </div>

          {loading ? <div className="empty">正在取详情…</div> : null}
          {error !== null ? <div className="empty">{error}</div> : null}

          {!loading && error === null && detail !== null ? (
            <>
              {tab === "content" ? <ContentPanel row={row} detail={detail} /> : null}
              {tab === "raw" ? <RawPanel row={row} detail={detail} /> : null}
              {tab === "related" ? <RelatedPanel detail={detail} /> : null}
            </>
          ) : null}
        </div>

        <div className="modal-foot">{footNote(row)}</div>
      </div>
    </div>
  );
}

function DetailMeta({ row, detail }: { row: StreamRow; detail: RowDetailData | null }) {
  const items: Array<[string, string]> = [];

  if (detail?.message !== null && detail?.message !== undefined) {
    items.push(["entry_id", detail.message.entry_id]);
    items.push(["parent_id", detail.message.parent_id ?? "—"]);
    items.push(["文件行号", String(detail.message.entry_index)]);
    items.push(["类型", `${detail.message.kind}${detail.message.role === null ? "" : ` · ${detail.message.role}`}`]);
    items.push(["时间", dateTime(detail.message.timestamp)]);
    items.push(["字节", `${detail.message.payload_bytes}（摘要 ${detail.message.text?.length ?? 0} 字）`]);
    items.push(["分支", row.onCurrentBranch ? "当前分支" : "其它分支"]);
  } else if (detail?.tool !== null && detail?.tool !== undefined) {
    items.push(["toolCallId", detail.tool.tool_call_id]);
    items.push(["toolName", detail.tool.tool_name]);
    items.push(["耗时", formatDuration(detail.tool.duration_ms)]);
    items.push(["状态", detail.tool.is_error === 1 ? "isError" : "成功"]);
    items.push(["entry_id", detail.tool.entry_id ?? "—"]);
    items.push(["result_entry_id", detail.tool.result_entry_id ?? "—"]);
    items.push(["参数 / 结果", `${formatBytes(detail.tool.args_bytes)} / ${formatBytes(detail.tool.result_bytes)}`]);
    items.push(["时间", dateTime(detail.tool.started_at ?? detail.tool.ended_at)]);
  } else if (detail?.request !== null && detail?.request !== undefined) {
    items.push(["会话内序号", String(detail.request.request_seq)]);
    items.push(["provider", detail.request.provider ?? "—"]);
    items.push(["api", detail.request.api ?? "—"]);
    items.push(["model", detail.request.model ?? "—"]);
    items.push(["payload", `${formatBytes(detail.request.payload_bytes)}${detail.request.payload_truncated === 1 ? "（已截断）" : ""}`]);
    items.push(["响应", detail.request.status === null ? "未到达" : String(detail.request.status)]);
    items.push(["时间", dateTime(detail.request.created_at)]);
  } else if (detail?.event !== null && detail?.event !== undefined) {
    items.push(["event_id", detail.event.event_id]);
    items.push(["event_type", detail.event.event_type]);
    items.push(["layer", detail.event.layer]);
    items.push(["run_seq", detail.event.run_seq === null ? "—" : String(detail.event.run_seq)]);
    items.push(["turn_index", detail.event.turn_index === null ? "—" : String(detail.event.turn_index)]);
    items.push(["时间", dateTime(detail.event.occurred_at)]);
    items.push(["收到", dateTime(detail.event.received_at)]);
  } else {
    if (row.entryId !== null) items.push(["entry_id", row.entryId]);
    if (row.toolCallId !== null) items.push(["toolCallId", row.toolCallId]);
    if (row.requestSeq !== null) items.push(["请求序号", String(row.requestSeq)]);
    if (row.eventId !== null) items.push(["event_id", row.eventId]);
    items.push(["时间", dateTime(row.at)]);
  }

  if (items.length === 0) return null;
  return (
    <div className="modal-meta">
      {items.map(([key, value]) => (
        <dl className="kv" key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </dl>
      ))}
    </div>
  );
}

function ContentPanel({ row, detail }: { row: StreamRow; detail: RowDetailData }) {
  if (detail.message !== null) {
    return <MessageContent message={detail.message} toolNames={row.toolNames} />;
  }
  if (detail.tool !== null) {
    return <ToolContent tool={detail.tool} relatedMessages={detail.relatedMessages} />;
  }
  if (detail.request !== null) {
    return <RequestContent request={detail.request} />;
  }
  if (detail.event !== null) {
    return <EventContent event={detail.event} detail={detail} />;
  }
  return <div className="empty">没有可显示的内容。</div>;
}

function MessageContent({ message, toolNames }: { message: MessageDetail; toolNames: string[] }) {
  const payload = asObject(message.payload);
  const body = asObject(payload?.message);
  const parts = Array.isArray(body?.content) ? body.content : [];
  const texts: string[] = [];
  const thinking: string[] = [];
  const tools: Array<{ name: string; args: unknown }> = [];

  for (const part of parts) {
    const item = asObject(part);
    if (item === null) continue;
    if (item.type === "text" && typeof item.text === "string" && item.text !== "") texts.push(item.text);
    if (item.type === "thinking" && typeof item.thinking === "string" && item.thinking !== "") {
      thinking.push(item.thinking);
    }
    if (item.type === "toolCall") {
      tools.push({
        name: typeof item.name === "string" ? item.name : "工具",
        args: item.arguments,
      });
    }
  }

  const preamble = asObject(body?.sections)?.preamble;
  return (
    <>
      <SectionLabel>text</SectionLabel>
      <div className="txt" style={{ whiteSpace: "pre-wrap", color: "var(--fg)" }}>
        {texts.length > 0 ? texts.join("\n\n") : message.text ?? (typeof preamble === "string" ? preamble : "（没有正文）")}
      </div>

      {thinking.length > 0 ? (
        <>
          <SectionLabel>thinking</SectionLabel>
          <div className="pre">{thinking.join("\n\n")}</div>
        </>
      ) : null}

      {tools.length > 0 ? (
        <>
          <SectionLabel>toolCall</SectionLabel>
          {tools.map((tool, index) => (
            <div key={`${tool.name}:${index}`}>
              <div className="faint" style={{ fontSize: 10, marginBottom: 4 }}>
                {tool.name}
              </div>
              <pre className="pre">{pretty(tool.args)}</pre>
            </div>
          ))}
        </>
      ) : null}

      {tools.length === 0 && toolNames.length > 0 ? (
        <>
          <SectionLabel>相关工具</SectionLabel>
          <div className="tchips">
            {toolNames.map((name, index) => (
              <span className="tchip" key={`${name}:${index}`}>
                → {name}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function ToolContent({ tool, relatedMessages }: { tool: ToolCallDetail; relatedMessages: MessageDetail[] }) {
  const resultEntry = relatedMessages.find((message) => message.entry_id === tool.result_entry_id);
  // v3 数据从结果条目里取文本；v2 旧数据没有条目引用，就从 tool_calls.result 里取
  const readable =
    resultEntry === undefined ? textOfToolResult(tool.result) : textOfToolResult(resultEntry.payload);
  return (
    <>
      <SectionLabel>结果</SectionLabel>
      {readable !== null ? (
        <pre className={`pre${tool.is_error === 1 ? " err" : ""}`}>{readable}</pre>
      ) : resultEntry !== undefined ? (
        <pre className={`pre${tool.is_error === 1 ? " err" : ""}`}>{pretty(resultEntry.payload)}</pre>
      ) : tool.result === null ? (
        <div className="empty">没有取到结果条目：可能还在执行，或旧数据没有条目引用。</div>
      ) : (
        <pre className={`pre${tool.is_error === 1 ? " err" : ""}`}>{pretty(tool.result)}</pre>
      )}

      <SectionLabel>参数</SectionLabel>
      <pre className="pre">{pretty(tool.args)}</pre>
      <div className="faint" style={{ fontSize: 10 }}>
        参数来自同 Turn 助手条目的 <code>toolCall</code> 块，不在 toolResult 条目里。
      </div>
    </>
  );
}

/**
 * toolResult 里可读的那部分。
 *
 * 两种形状都见过：v3 的结果条目是 `{ message: { content: [...] } }`，
 * v2 旧库的 `tool_calls.result` 直接就是 `{ content: [...] }`。
 * 取不到文本就返回 null，调用方退回原始 JSON，不编内容。
 */
function textOfToolResult(payload: unknown): string | null {
  const body = asObject(payload);
  if (body === null) return null;
  const message = asObject(body.message) ?? body;
  const content = message.content;
  if (typeof content === "string") return content === "" ? null : content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    const item = asObject(part);
    if (item === null) continue;
    if (item.type === "text" && typeof item.text === "string" && item.text !== "") parts.push(item.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function RequestContent({ request }: { request: RequestDetail }) {
  return (
    <>
      <SectionLabel>概览</SectionLabel>
      <dl className="kv" style={{ marginBottom: 12 }}>
        <dt>关联 Turn</dt>
        <dd>
          {request.run_seq === null || request.turn_index === null ? "—" : `${request.run_seq}:${request.turn_index}`}
        </dd>
        <dt>响应</dt>
        <dd>{request.status === null ? "未到达" : String(request.status)}</dd>
        <dt>token</dt>
        <dd>
          {request.tokens_in === null ? "—" : `↑ ${formatTokens(request.tokens_in)}`} /{" "}
          {request.tokens_out === null ? "—" : `↓ ${formatTokens(request.tokens_out)}`}
        </dd>
        <dt>说明</dt>
        <dd className="faint">请求 / 响应按会话内顺序配对，没有共享请求 ID。</dd>
      </dl>

      <SectionLabel>请求体（脱敏）</SectionLabel>
      <pre className="pre">{pretty(request.payload)}</pre>

      <SectionLabel>响应头（脱敏）</SectionLabel>
      <pre className="pre">{pretty(request.response_headers)}</pre>
    </>
  );
}

function EventContent({ event, detail }: { event: EventRow; detail: RowDetailData }) {
  return (
    <>
      <SectionLabel>钩子入参</SectionLabel>
      <pre className="pre">{pretty(event.payload)}</pre>

      {detail.relatedTools.length > 0 ? (
        <>
          <SectionLabel>关联工具</SectionLabel>
          {detail.relatedTools.map((tool) => (
            <div className="kv" key={tool.tool_call_id} style={{ marginBottom: 6 }}>
              <dt>toolCallId</dt>
              <dd>{tool.tool_call_id}</dd>
              <dt>toolName</dt>
              <dd>{tool.tool_name}</dd>
              <dt>条目</dt>
              <dd>
                {tool.entry_id ?? "—"} / {tool.result_entry_id ?? "—"}
              </dd>
            </div>
          ))}
        </>
      ) : null}

      {detail.relatedRequest !== null ? (
        <>
          <SectionLabel>关联请求</SectionLabel>
          <div className="kv" style={{ marginBottom: 6 }}>
            <dt>序号</dt>
            <dd>#{detail.relatedRequest.request_seq}</dd>
            <dt>provider</dt>
            <dd>{detail.relatedRequest.provider ?? "—"}</dd>
            <dt>model</dt>
            <dd>{detail.relatedRequest.model ?? "—"}</dd>
            <dt>响应</dt>
            <dd>{detail.relatedRequest.status === null ? "未到达" : detail.relatedRequest.status}</dd>
          </div>
        </>
      ) : null}

      {detail.relatedMessages.length > 0 ? (
        <>
          <SectionLabel>关联条目</SectionLabel>
          <div className="kv">
            {detail.relatedMessages.map((message) => (
              <div key={message.entry_id} style={{ display: "contents" }}>
                <dt>{shortId(message.entry_id)}</dt>
                <dd>
                  {message.kind} · {message.role ?? "—"} · {message.payload_bytes} B
                </dd>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function RawPanel({ row, detail }: { row: StreamRow; detail: RowDetailData }) {
  let value: unknown = null;
  if (detail.message !== null) value = detail.message.payload;
  else if (detail.tool !== null) {
    const resultEntry = detail.relatedMessages.find(
      (message) => message.entry_id === detail.tool?.result_entry_id,
    );
    value = resultEntry?.payload ?? detail.tool.result ?? detail.tool.args;
  } else if (detail.request !== null) value = detail.request.payload;
  else if (detail.event !== null) value = detail.event.payload;

  return (
    <>
      <div className="faint" style={{ fontSize: 10, marginBottom: 6 }}>
        原始 JSON · {row.fromFile ? "来自会话文件" : "钩子事件"}
      </div>
      <pre className="pre">{pretty(value)}</pre>
    </>
  );
}

function RelatedPanel({ detail }: { detail: RowDetailData }) {
  const hasAny =
    detail.relatedEvents.length > 0 || detail.relatedTools.length > 0 || detail.relatedRequest !== null;
  if (!hasAny) {
    return <div className="empty">这一条没有直接关联的钩子事件、请求或工具。</div>;
  }

  return (
    <>
      {detail.relatedEvents.map((event) => (
        <div className="panel" key={event.event_id} style={{ marginBottom: 8 }}>
          <div className="panel-head">
            <span>{event.event_type}</span>
            <span className="count">{clockTime(event.occurred_at)}</span>
            <span className="count">{event.event_id}</span>
          </div>
          <pre className="pre" style={{ margin: 0, border: 0, borderRadius: 0 }}>
            {pretty(event.payload)}
          </pre>
        </div>
      ))}

      {detail.relatedTools.map((tool) => (
        <div className="panel" key={tool.tool_call_id} style={{ marginBottom: 8 }}>
          <div className="panel-head">
            <span>工具 · {tool.tool_name}</span>
            <span className="count">{tool.tool_call_id}</span>
          </div>
          <div className="panel-body">
            <pre className="pre" style={{ margin: 0 }}>
              {pretty(tool.args)}
            </pre>
          </div>
        </div>
      ))}

      {detail.relatedRequest !== null ? (
        <div className="panel">
          <div className="panel-head">
            <span>请求 · #{detail.relatedRequest.request_seq}</span>
            <span className="count">{detail.relatedRequest.model ?? "—"}</span>
          </div>
          <div className="panel-body">
            <pre className="pre" style={{ margin: 0 }}>
              {pretty(detail.relatedRequest.payload)}
            </pre>
          </div>
        </div>
      ) : null}
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="modal-label">{children}</div>;
}

function modalTitle(row: StreamRow): string {
  switch (detailKind(row)) {
    case "tool":
      return `${row.toolName ?? "工具"} · ${shortId(row.toolCallId ?? "")}`;
    case "request":
      return `请求 #${row.requestSeq} · ${row.label}`;
    case "event":
      return `${row.label} · ${shortId(row.eventId ?? "")}`;
    default:
      return `${row.label} · ${shortId(row.entryId ?? "")}`;
  }
}

function footNote(row: StreamRow): string {
  if (row.fromFile) {
    return "来自会话文件。正文、思考与工具参数都从这里取；存储去重后这是唯一一份。";
  }
  if (row.kind === "request" || row.kind === "response") {
    return "请求与响应来自钩子；payload 已脱敏，超过上限时截断。payload 只保留在看板库里，不改动 Pi 的文件。";
  }
  return "钩子事件只补文件里没有的信息：运行状态、工具起止、请求与响应。";
}

function detailKind(row: StreamRow): "message" | "tool" | "request" | "event" | null {
  if (row.kind === "tool" && row.toolCallId !== null) return "tool";
  if ((row.kind === "request" || row.kind === "response") && row.requestSeq !== null) return "request";
  if (row.kind === "event" && row.eventId !== null) return "event";
  if (row.entryId !== null) return "message";
  return null;
}

function detailId(row: StreamRow): string | null {
  switch (detailKind(row)) {
    case "tool":
      return row.toolCallId;
    case "request":
      return row.requestSeq === null ? null : String(row.requestSeq);
    case "event":
      return row.eventId;
    case "message":
      return row.entryId;
    default:
      return null;
  }
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
