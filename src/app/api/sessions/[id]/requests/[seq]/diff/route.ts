import { config } from "@/lib/config.ts";
import { getDb } from "@/lib/db.ts";
import { buildRows, diffLines, jsonLines, toBlocks } from "@/lib/diff.ts";
import { payloadsRoot, readPayloadJson } from "@/lib/payload-files.ts";
import { getRequestDetail } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 两次模型请求的逐行差异。
 *
 * 对比的是同一个会话里相邻两次请求（seq 与 seq-1）的完整请求体，
 * 正文都在 `data/payloads/request/` 里，这里读文件后按行比较。
 *
 * 只在会话内对比：会话之间的请求没有可比性（上下文完全不同）。
 * 上一条不存在时如实说明，不去别处找。
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; seq: string }> },
): Promise<Response> {
  const { id, seq: seqRaw } = await ctx.params;
  const seq = Number(seqRaw);
  if (!Number.isFinite(seq) || seq < 1) {
    return Response.json({ ok: false, error: "请求序号不合法" }, { status: 400 });
  }

  const db = getDb();
  const root = payloadsRoot(config().dataDir);

  const current = getRequestDetail(id, seq, db);
  if (current === null) {
    return Response.json({ ok: false, error: "找不到这一条请求" }, { status: 404 });
  }

  const previous = seq > 1 ? getRequestDetail(id, seq - 1, db) : null;
  if (previous === null) {
    return Response.json({
      ok: true,
      hasPrevious: false,
      current: { seq, bytes: current.payload_bytes, model: current.model },
      message: "这是该会话的第一条请求，没有可对比的上一条。",
    });
  }

  const before = readPayloadJson(root, previous.payload_path);
  const after = readPayloadJson(root, current.payload_path);
  if (before === null || after === null) {
    return Response.json({
      ok: true,
      hasPrevious: false,
      current: { seq, bytes: current.payload_bytes, model: current.model },
      message: "请求体的正文文件不在了（可能已被清理），无法对比。",
    });
  }

  const ops = diffLines(jsonLines(before), jsonLines(after));
  const rows = buildRows(ops);

  return Response.json({
    ok: true,
    hasPrevious: true,
    current: { seq, bytes: current.payload_bytes, model: current.model },
    previous: { seq: previous.request_seq, bytes: previous.payload_bytes, model: previous.model },
    added: ops.filter((op) => op.type === "added").length,
    removed: ops.filter((op) => op.type === "removed").length,
    blocks: toBlocks(rows, 3),
  });
}
