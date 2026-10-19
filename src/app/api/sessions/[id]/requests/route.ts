import { getDb } from "@/lib/db.ts";
import { jsonError } from "@/lib/http.ts";
import { countRequests, getRequestDetail, listRequests } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 模型请求（PRD §11.2 视图二）。
 *
 *   - 不带 `seq`：返回列表行（不含 payload / headers），按请求序号倒序；
 *   - 带 `seq=<request_seq>`：返回单条详情（脱敏 payload、响应头、关联 Turn 的 usage）。
 *
 * 只读：没有重发、没有改参数。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const db = getDb();

  const seqRaw = url.searchParams.get("seq");
  if (seqRaw !== null && seqRaw !== "") {
    const seq = Number(seqRaw);
    if (!Number.isSafeInteger(seq) || seq < 1) return jsonError(400, `seq 必须是正整数，收到 ${seqRaw}`);
    const detail = getRequestDetail(id, seq, db);
    if (detail === null) return jsonError(404, `会话 ${id} 里没有请求 #${seq}`);
    return Response.json({ ok: true, request: detail });
  }

  const limitRaw = Number(url.searchParams.get("limit") ?? "200");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1000) : 200;
  const requests = listRequests(id, limit, db);
  return Response.json({
    ok: true,
    count: requests.length,
    total: countRequests(id, db),
    requests,
  });
}
