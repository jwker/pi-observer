import { getDb } from "@/lib/db.ts";
import { listSessions } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 会话列表（PRD §10）；`cwd` 用于按项目筛选 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "200");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;
  const cwd = url.searchParams.get("cwd");

  const sessions = listSessions(getDb(), limit).filter((s) => (cwd ? s.cwd === cwd : true));
  return Response.json({ ok: true, count: sessions.length, sessions });
}
