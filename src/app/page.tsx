import { AppShell } from "@/components/app-shell.tsx";
import { ensureSessionBackfilled } from "@/lib/backfill.ts";
import { getDb } from "@/lib/db.ts";
import { log } from "@/lib/log.ts";
import { countSessions, listSessionItems, sessionStreamData, streamVersion } from "@/lib/queries.ts";
import type { SessionStreamData } from "@/lib/types.ts";

export const dynamic = "force-dynamic";

/**
 * 单页看板（R3）：左栏项目 / 会话，右栏直接打开时间线。
 * `?session=<id>` 与当前会话同步；没有参数时选中最近活跃的一个。
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const params = await searchParams;
  const requested = Array.isArray(params.session) ? params.session[0] : params.session;
  const db = getDb();
  const sessions = listSessionItems(500, db);
  const total = countSessions(db);
  const selected = sessions.find((session) => session.session_id === requested) ?? sessions[0] ?? null;
  const selectedId = selected?.session_id ?? null;

  let data: SessionStreamData | null = null;
  let version: string | null = null;
  if (selectedId !== null) {
    try {
      ensureSessionBackfilled(selectedId);
    } catch (error) {
      log("warn", "backfill", "首屏补读失败", { session_id: selectedId, error: (error as Error).message });
    }
    data = sessionStreamData(selectedId, db);
    version = streamVersion(selectedId, db);
  }

  return (
    <AppShell
      initialSessions={sessions}
      initialTotal={total}
      initialSessionId={selectedId}
      initialData={data}
      initialVersion={version}
    />
  );
}
