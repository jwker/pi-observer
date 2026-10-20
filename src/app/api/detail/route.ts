import { getDb } from "@/lib/db.ts";
import {
  getEventDetail,
  getMessageDetail,
  getRequestDetail,
  getToolCallDetail,
} from "@/lib/queries.ts";
import type {
  MessageDetail,
  RowDetailData,
  RowDetailKind,
  ToolCallDetail,
} from "@/lib/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set<RowDetailKind>(["message", "tool", "request", "event"]);

/**
 * 行详情弹窗的数据（R3）。
 *
 * 参数：
 *   session  会话 id
 *   kind     message / tool / request / event
 *   id       entry_id / tool_call_id / request_seq / event_id
 *   related  当前行关联的事件 id（逗号分隔），由时间线行带过来
 *
 * 只返回当前行需要的完整内容：正文与原始 JSON 在这里才从 `messages.payload`
 * 取出来，时间线本身不带这些大字段。
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session");
  const kindRaw = url.searchParams.get("kind");
  const id = url.searchParams.get("id");

  if (sessionId === null || id === null || kindRaw === null || !KINDS.has(kindRaw as RowDetailKind)) {
    return Response.json({ ok: false, error: "参数不完整" }, { status: 400 });
  }
  const kind = kindRaw as RowDetailKind;

  const db = getDb();
  const detail: RowDetailData = {
    kind,
    message: null,
    tool: null,
    request: null,
    event: null,
    relatedEvents: [],
    relatedTools: [],
    relatedRequest: null,
    relatedMessages: [],
  };
  const relatedMessages = new Map<string, MessageDetail>();
  const relatedTools = new Map<string, ToolCallDetail>();
  const eventIds = new Set<string>(
    (url.searchParams.get("related") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== ""),
  );

  const addMessage = (entryId: string | null): void => {
    if (entryId === null || relatedMessages.has(entryId)) return;
    const message = getMessageDetail(sessionId, entryId, db);
    if (message !== null) relatedMessages.set(entryId, message);
  };

  const addTool = (toolCallId: string): void => {
    if (relatedTools.has(toolCallId)) return;
    const tool = getToolCallDetail(sessionId, toolCallId, db);
    if (tool === null) return;
    relatedTools.set(toolCallId, tool);
    addMessage(tool.entry_id);
    addMessage(tool.result_entry_id);
  };

  if (kind === "message") {
    detail.message = getMessageDetail(sessionId, id, db);
    if (detail.message === null) return notFound();
    // 这个条目里如果有 toolCall，把对应工具调用也带出来，弹窗可显示参数 / 结果
    const rows = db
      .prepare(
        `SELECT tool_call_id FROM tool_calls
          WHERE session_id = ? AND (entry_id = ? OR result_entry_id = ?)`,
      )
      .all(sessionId, id, id) as Array<{ tool_call_id: string }>;
    for (const row of rows) addTool(row.tool_call_id);
  } else if (kind === "tool") {
    detail.tool = getToolCallDetail(sessionId, id, db);
    if (detail.tool === null) return notFound();
    addMessage(detail.tool.entry_id);
    addMessage(detail.tool.result_entry_id);
  } else if (kind === "request") {
    const requestSeq = Number(id);
    if (!Number.isFinite(requestSeq)) return notFound();
    detail.request = getRequestDetail(sessionId, requestSeq, db);
    if (detail.request === null) return notFound();
  } else {
    detail.event = getEventDetail(sessionId, id, db);
    if (detail.event === null) return notFound();
    const payload = asObject(detail.event.payload);
    const toolCallId = strOf(payload?.toolCallId);
    if (toolCallId !== null) addTool(toolCallId);
    const requestSeq = numOf(payload?.requestSeq);
    if (requestSeq !== null) {
      detail.relatedRequest = getRequestDetail(sessionId, requestSeq, db);
    }
  }

  for (const eventId of eventIds) {
    if (detail.event !== null && eventId === detail.event.event_id) continue;
    const event = getEventDetail(sessionId, eventId, db);
    if (event !== null) detail.relatedEvents.push(event);
  }

  detail.relatedTools = [...relatedTools.values()];
  detail.relatedMessages = [...relatedMessages.values()];
  return Response.json({ ok: true, detail });

  function notFound(): Response {
    return Response.json({ ok: false, error: "找不到这一行" }, { status: 404 });
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
