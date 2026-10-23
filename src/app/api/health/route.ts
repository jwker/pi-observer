import { config } from "@/lib/config.ts";
import { dbStatus, getDb } from "@/lib/db.ts";
import { recentProblems } from "@/lib/log.ts";
import { subscriberCount } from "@/lib/sse.ts";
import { probeStatus } from "@/lib/queries.ts";
import { PROBE_PROTOCOL_VERSION, PROBE_VERSION } from "@/lib/protocol.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 探针启动时用它判断服务是否可用（PRD §7.5） */
export async function GET(): Promise<Response> {
  const status = dbStatus(getDb());
  return Response.json({
    ok: true,
    service: "pi-observer",
    version: PROBE_VERSION,
    protocol: PROBE_PROTOCOL_VERSION,
    sqlite: status.sqliteVersion,
    schema_user_version: status.userVersion,
    subscribers: subscriberCount(),
    // 服务实际监听的地址：桌面版会自己挑端口，写死 4173 会显示错
    base_url: `http://${config().host}:${config().port}`,
    probe: probeStatus(getDb()),
    // 拒批、令牌错误这类 warn 只写 stderr，浏览器里看不到；这里带出去，
    // 否则探针那边「已丢弃 N 条」和看板的 dropped_count=0 都无法解释（M3-6 修）
    recent_problems: recentProblems(10),
  });
}
