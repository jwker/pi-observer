import { loadSessionWindow } from "@/lib/session-view.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 单个会话的一段展示数据。
 *
 * 参数：
 *   id      会话 id
 *   turns   这一段给多少个 Turn（默认 20）
 *   before  只给序号不大于它的 Turn；页面「加载更早」时带上
 *
 * 没有实时刷新：页面点「刷新」再来一次。
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("id");
  if (sessionId === null || sessionId.trim() === "") {
    return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
  }

  const turnsRaw = Number(url.searchParams.get("turns") ?? "20");
  const beforeRaw = url.searchParams.get("before");

  try {
    const window = await loadSessionWindow(sessionId, {
      turns: Number.isFinite(turnsRaw) ? Math.min(Math.max(turnsRaw, 1), 200) : 20,
      before: beforeRaw === null ? undefined : Number(beforeRaw),
    });
    if (window === null) {
      return Response.json({ ok: false, error: "会话不存在" }, { status: 404 });
    }
    return Response.json({ ok: true, data: window });
  } catch (error) {
    return Response.json(
      { ok: false, error: `读取会话失败：${(error as Error).message}` },
      { status: 500 },
    );
  }
}
