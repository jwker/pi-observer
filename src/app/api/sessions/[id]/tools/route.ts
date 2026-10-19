import { getDb } from "@/lib/db.ts";
import { jsonError } from "@/lib/http.ts";
import { countToolCalls, getToolCallDetail, listToolCallIndex } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 工具调用（PRD §11.2 视图三）。
 *
 *   - 不带 `call`：返回列表行（参数只带前 500 字符预览与字节数）；
 *   - 带 `call=<toolCallId>`：返回完整参数、结果与部分结果。
 *
 * 只读：不重放、不修改、不注入。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const db = getDb();

  const callId = url.searchParams.get("call");
  if (callId !== null && callId !== "") {
    const detail = getToolCallDetail(id, callId, db);
    if (detail === null) return jsonError(404, `会话 ${id} 里没有工具调用 ${callId}`);
    return Response.json({ ok: true, tool: detail });
  }

  const limitRaw = Number(url.searchParams.get("limit") ?? "500");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 2000) : 500;
  const tools = listToolCallIndex(id, limit, db);
  return Response.json({
    ok: true,
    count: tools.length,
    total: countToolCalls(id, db),
    tools,
  });
}
