import { SessionList } from "@/components/session-list.tsx";
import { getDb } from "@/lib/db.ts";
import { listSessions } from "@/lib/queries.ts";

export const dynamic = "force-dynamic";

export default function SessionsPage() {
  const sessions = listSessions(getDb());

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">
          <h1>会话列表</h1>
          <div className="crumb">
            按项目分组 · 按最后活跃时间倒序 · 共 {sessions.length} 个会话
          </div>
        </div>
      </div>
      <SessionList initial={sessions} />
    </div>
  );
}
