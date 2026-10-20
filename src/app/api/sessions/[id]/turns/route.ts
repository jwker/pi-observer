import { getDb } from "@/lib/db.ts";
import { listTurns, sessionUsage } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 会话的 Turn 列表（时间线的头部指标来自这里） */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "500");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 500;

  const db = getDb();
  const turns = listTurns(id, limit, db);
  return Response.json({ ok: true, count: turns.length, turns, usage: sessionUsage(id, db) });
}
