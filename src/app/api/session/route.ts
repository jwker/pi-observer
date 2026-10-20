import { ensureSessionBackfilled } from "@/lib/backfill.ts";
import { getDb } from "@/lib/db.ts";
import { log } from "@/lib/log.ts";
import { sessionStreamData, streamVersion } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 单页的时间线数据（R3）。
 *
 * 没有 `v` 或版本不一致时返回整套 `SessionStreamData`；版本一致时只返回
 * `{ unchanged: true }`。活跃会话页面每秒用上一拍的版本号轮询，文件没变时
 * 响应只有几十字节，不必每秒把 20k 条消息序列化一遍。
 *
 * 进入会话时顺手补读一次文件（PRD §9.1）：文件没变时只是两次 stat，失败不挡页面。
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("id");
  if (sessionId === null || sessionId.trim() === "") {
    return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
  }

  const db = getDb();
  try {
    ensureSessionBackfilled(sessionId);
  } catch (error) {
    log("warn", "backfill", "进页面补读失败", { session_id: sessionId, error: (error as Error).message });
  }

  const version = streamVersion(sessionId, db);
  if (version === null) {
    return Response.json({ ok: false, error: "会话不存在" }, { status: 404 });
  }
  if (url.searchParams.get("v") === version) {
    return Response.json({ ok: true, unchanged: true, version });
  }

  const data = sessionStreamData(sessionId, db);
  if (data === null) {
    return Response.json({ ok: false, error: "会话不存在" }, { status: 404 });
  }
  return Response.json({ ok: true, version, data });
}
