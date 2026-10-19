import { ensureToken, tokensMatch } from "@/lib/auth.ts";
import { config } from "@/lib/config.ts";
import { getDb } from "@/lib/db.ts";
import { jsonError, readBodyCapped } from "@/lib/http.ts";
import { applyBatch, parseBatch } from "@/lib/ingest.ts";
import { log } from "@/lib/log.ts";
import { afterIngest } from "@/lib/reconcile.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_HEADER = "x-observer-token";

/** 探针批量写入（PRD §7.5 / §10）。只接受带正确令牌的请求 */
export async function POST(req: Request): Promise<Response> {
  const expected = ensureToken();
  const provided = req.headers.get(TOKEN_HEADER);
  if (!tokensMatch(provided, expected)) {
    log("warn", "ingest", "令牌校验失败", { has_header: provided !== null });
    return jsonError(401, "x-observer-token 缺失或不正确");
  }

  const cfg = config();
  const body = await readBodyCapped(req, cfg.ingestMaxBytes);
  if (!body.ok) {
    log("warn", "ingest", "拒绝过大的批次", { reason: body.reason });
    return jsonError(413, body.reason);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch (error) {
    return jsonError(400, `请求体不是合法 JSON：${(error as Error).message}`);
  }

  const parsed = parseBatch(raw);
  if (!parsed.ok) {
    log("warn", "ingest", "批次校验失败", { error: parsed.error });
    return jsonError(400, parsed.error);
  }

  try {
    const result = applyBatch(parsed.batch, getDb());
    // 落库之后才推进状态、排对账（PRD §9.3）：写库失败时不该留下「已结束」或待对账的定时器
    const followUp = afterIngest(parsed.batch.records);
    if (followUp.ended.length > 0 || followUp.scheduled.length > 0) {
      log("info", "ingest", "批次后的状态推进", {
        ended: followUp.ended,
        scheduled: followUp.scheduled,
      });
    }
    return Response.json(result);
  } catch (error) {
    log("error", "ingest", "写入失败", { error: (error as Error).message });
    return jsonError(500, `写入失败：${(error as Error).message}`);
  }
}
