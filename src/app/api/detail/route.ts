import { loadEntryDetail } from "@/lib/session-view.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 一条条目的原文（行详情弹窗用）。
 *
 * 只读会话文件里的条目，不碰 provider 请求正文——
 * 那些文件由探针写到 iCloud，本项目不读。
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session");
  const entryId = url.searchParams.get("id");
  if (sessionId === null || entryId === null) {
    return Response.json({ ok: false, error: "参数不完整" }, { status: 400 });
  }

  try {
    const detail = await loadEntryDetail(sessionId, entryId);
    if (detail === null) {
      return Response.json({ ok: false, error: "找不到这一条" }, { status: 404 });
    }
    return Response.json({ ok: true, detail });
  } catch (error) {
    return Response.json(
      { ok: false, error: `读取条目失败：${(error as Error).message}` },
      { status: 500 },
    );
  }
}
