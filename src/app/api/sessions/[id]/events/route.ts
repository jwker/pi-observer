import { getDb } from "@/lib/db.ts";
import { listEvents } from "@/lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 时间线事件（PRD §10）。`after_id` 供实时增量拉取 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "500");
  const afterRaw = url.searchParams.get("after_id");
  const afterId = afterRaw === null ? undefined : Number(afterRaw);

  const events = listEvents(
    id,
    {
      limit: Number.isFinite(limitRaw) ? limitRaw : 500,
      layer: url.searchParams.get("layer") ?? undefined,
      eventType: url.searchParams.get("type") ?? undefined,
      afterId: afterId !== undefined && Number.isFinite(afterId) ? afterId : undefined,
    },
    getDb(),
  );

  return Response.json({ ok: true, count: events.length, events });
}
