import { getDb } from "@/lib/db.ts";
import { countSessions, listSessionItems, overviewStats } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 会话列表（PRD §10）。`cwd` 用于按项目筛选。
 *
 * 返回列表行（含首条用户消息摘要）与概览条指标：列表页收到 `session.updated` 时
 * 一次拉取两者，避免列表和指标对不上。
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "200");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;
  const cwd = url.searchParams.get("cwd");
  const db = getDb();

  const sessions = listSessionItems(limit, db).filter((s) => (cwd ? s.cwd === cwd : true));
  return Response.json({
    ok: true,
    count: sessions.length,
    total: countSessions(db),
    sessions,
    stats: overviewStats(db),
  });
}
