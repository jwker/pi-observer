import { getDb } from "@/lib/db.ts";
import { sessionCursor } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 会话已有数据的最大序号（只读）。
 *
 * 探针在本地游标文件缺失时（第一次跑新版本、或换了数据目录）用它种子化：
 * 否则 `--resume` 一个旧会话时 run_seq 会从 1 重来，覆盖 runs 并让请求与 Turn 关联撞车。
 * 返回的是「库里最大的已用序号」，不是下一个序号；探针自己 +1。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const cursor = sessionCursor(id, getDb());
  return Response.json({ ok: true, ...cursor });
}
