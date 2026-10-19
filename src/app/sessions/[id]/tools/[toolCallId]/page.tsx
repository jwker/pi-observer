import Link from "next/link";
import { notFound } from "next/navigation";

import { ToolDetailView } from "@/components/tool-detail.tsx";
import { getDb } from "@/lib/db.ts";
import { formatDuration, shortId } from "@/lib/format.ts";
import { getSession, getToolCallDetail, listRequests } from "@/lib/queries.ts";
import { toolArgSummary, toolStatusMeta } from "@/lib/tool-view.ts";

export const dynamic = "force-dynamic";

export default async function ToolCallPage({ params }: { params: Promise<{ id: string; toolCallId: string }> }) {
  const { id, toolCallId } = await params;

  const db = getDb();
  const tool = getToolCallDetail(id, toolCallId, db);
  if (tool === null) notFound();

  const session = getSession(id, db);
  const status = toolStatusMeta(tool.is_error, tool.duration_ms);
  const requestSeq =
    tool.run_seq === null || tool.turn_index === null
      ? null
      : (listRequests(id, 500, db).find(
          (request) => request.run_seq === tool.run_seq && request.turn_index === tool.turn_index,
        )?.request_seq ?? null);

  return (
    <div className="page narrow">
      <div className="page-head">
        <div className="title">
          <div className="crumb">
            <Link href="/">会话列表</Link> / <Link href={`/sessions/${encodeURIComponent(id)}`}>{shortId(id)}</Link> /
            工具调用
          </div>
          <h1>
            <span style={{ color: "var(--pink)" }}>{tool.tool_name || "—"}</span>
            <span className="faint"> · {toolArgSummary(tool.args_preview, 80)}</span>
          </h1>
        </div>
        <div className="spacer" />
        <span className={status.className} title={status.title}>
          {status.label}
        </span>
        <span className="badge">{formatDuration(tool.duration_ms)}</span>
      </div>

      <ToolDetailView sessionId={id} sessionCwd={session?.cwd ?? ""} tool={tool} requestSeq={requestSeq} />
    </div>
  );
}
