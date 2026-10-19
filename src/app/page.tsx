import { SessionList } from "@/components/session-list.tsx";
import { getDb } from "@/lib/db.ts";
import { countSessions, listSessionItems, overviewStats } from "@/lib/queries.ts";

export const dynamic = "force-dynamic";

export default function SessionsPage() {
  const db = getDb();
  const sessions = listSessionItems(200, db);
  const totalSessions = countSessions(db);

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">
          <h1>会话列表</h1>
          <div className="crumb">
            {`按项目分组 · 按最后活跃时间倒序 · 共 ${totalSessions} 个会话${
              totalSessions > sessions.length ? `（只显示最近 ${sessions.length} 个）` : ""
            }`}
          </div>
        </div>
      </div>
      <SessionList initial={sessions} initialStats={overviewStats(db)} totalSessions={totalSessions} />
    </div>
  );
}
