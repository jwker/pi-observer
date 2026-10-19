import { ensureToken, tokensMatch } from "@/lib/auth.ts";
import { createBackfillContext, ensureSessionBackfilled, scanSessionsDir } from "@/lib/backfill.ts";
import { getDb } from "@/lib/db.ts";
import { jsonError } from "@/lib/http.ts";
import { log } from "@/lib/log.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_HEADER = "x-observer-token";

/**
 * 手动触发回填（PRD §9.1）。**只写看板自己的库，不碰 Pi 的会话文件。**
 *
 * 启动时已经扫过一次；这个入口是给「文件在启动之后才出现/变化」和验收脚本用的。
 *   - `POST /api/backfill`：扫一遍会话目录（没变的文件会跳过）
 *   - `POST /api/backfill?session=<id>`：只补读一个会话
 *
 * 因为是写接口，与 `/api/ingest` 一样要求探针令牌。
 */
export async function POST(req: Request): Promise<Response> {
  const expected = ensureToken();
  if (!tokensMatch(req.headers.get(TOKEN_HEADER), expected)) {
    log("warn", "backfill", "令牌校验失败", { has_header: req.headers.get(TOKEN_HEADER) !== null });
    return jsonError(401, "x-observer-token 缺失或不正确");
  }

  const sessionId = new URL(req.url).searchParams.get("session");
  try {
    const ctx = createBackfillContext({ onWarning: (message) => log("warn", "backfill", message) });
    if (sessionId !== null && sessionId !== "") {
      const one = ensureSessionBackfilled(sessionId, ctx);
      log("info", "backfill", "补读一个会话", {
        session_id: sessionId,
        found: one !== null,
        skipped: one?.skipped ?? null,
        entries: one?.entries ?? 0,
      });
      return Response.json({ ok: true, mode: "session", session_id: sessionId, found: one !== null, summary: one });
    }

    const summary = scanSessionsDir(ctx);
    log("info", "backfill", "手动扫描完成", {
      files: summary.files,
      skipped: summary.skipped,
      changed: summary.changed,
      entries: summary.entries,
      warnings: summary.warnings.length,
      took_ms: summary.tookMs,
    });
    return Response.json({ ok: true, mode: "scan", summary });
  } catch (error) {
    log("error", "backfill", "回填失败", { error: (error as Error).message });
    return jsonError(500, `回填失败：${(error as Error).message}`);
  }
}

/** 当前库里已有多少条目（验收与排查用，不做任何写操作） */
export async function GET(): Promise<Response> {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions)   AS sessions,
         (SELECT COUNT(*) FROM messages)   AS messages,
         (SELECT COUNT(*) FROM turns)      AS turns,
         (SELECT COUNT(*) FROM tool_calls) AS tool_calls,
         (SELECT COUNT(*) FROM jsonl_files) AS files`,
    )
    .get() as Record<string, number>;
  return Response.json({ ok: true, counts: { ...counts } });
}
