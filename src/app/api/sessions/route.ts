import { listSessionItems } from "@/lib/session-view.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 会话列表。
 *
 * 数据直接来自会话文件目录：每个文件读头部与第一条用户消息，
 * 不会把整个文件读进来。
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "500");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 500;
  const cwd = url.searchParams.get("cwd");

  const all = listSessionItems(2000);
  const sessions = all.filter((session) => (cwd ? session.cwd === cwd : true)).slice(0, limit);
  return Response.json({
    ok: true,
    count: sessions.length,
    total: all.length,
    sessions,
  });
}
