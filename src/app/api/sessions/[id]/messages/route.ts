import { getDb } from "@/lib/db.ts";
import { jsonError } from "@/lib/http.ts";
import { countMessages, getMessageDetail, listMessageIndex } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 消息树（PRD §11.2）。
 *
 *   - 不带 `entry`：返回**索引行**（不含 payload，正文摘要截到 200 字符），用于渲染树；
 *     顺带返回条目总数，好让界面如实说明有没有被 `limit` 截断。
 *   - 带 `entry=<entryId>`：返回这一条条目的全文与原始 JSON——点开节点时才取，
 *     因为单条 payload 最大可以到 512 KB。
 *
 * 只读：这里没有任何写操作。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const db = getDb();

  const entryId = url.searchParams.get("entry");
  if (entryId !== null && entryId !== "") {
    const detail = getMessageDetail(id, entryId, db);
    if (detail === null) return jsonError(404, `会话 ${id} 里没有条目 ${entryId}`);
    return Response.json({ ok: true, message: detail });
  }

  const limitRaw = Number(url.searchParams.get("limit") ?? "5000");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 20000) : 5000;
  const messages = listMessageIndex(id, limit, db);
  return Response.json({ ok: true, count: messages.length, total: countMessages(id, db), messages });
}
