import Link from "next/link";
import { notFound } from "next/navigation";

import { Timeline } from "@/components/timeline.tsx";
import { dateTime, formatCost, formatTokens, relativeTime } from "@/lib/format.ts";
import { getDb } from "@/lib/db.ts";
import { getSession, listEvents, listTurns, probeStatus } from "@/lib/queries.ts";

export const dynamic = "force-dynamic";

const STATE_LABELS: Record<string, { label: string; className: string }> = {
  active: { label: "进行中", className: "badge ok" },
  idle: { label: "空闲", className: "badge warn" },
  ended: { label: "已结束", className: "badge" },
};

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const session = getSession(id, db);
  if (!session) notFound();

  const events = listEvents(id, { limit: 2000 }, db);
  const turns = listTurns(id, 500, db);
  const probe = probeStatus(db);
  const state = STATE_LABELS[session.state] ?? STATE_LABELS.ended;

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">
          <div className="crumb">
            <Link href="/">会话列表</Link> / {session.cwd || "（未知工作目录）"}
          </div>
          <h1>{session.session_id}</h1>
        </div>
        <div className="spacer" />
        <span className={state.className}>{state.label}</span>
      </div>

      <div className="panel">
        <div className="panel-body" style={{ display: "flex", gap: 34, flexWrap: "wrap" }}>
          <dl className="kv">
            <dt>工作目录</dt>
            <dd>{session.cwd || "—"}</dd>
            <dt>开始时间</dt>
            <dd>{dateTime(session.started_at)}</dd>
            <dt>最后活跃</dt>
            <dd>{relativeTime(session.last_activity_at)}</dd>
            <dt>来源</dt>
            <dd>
              <span className="badge info">{session.source}</span>{" "}
              {session.source === "live" ? "探针实时推送" : session.source === "backfill" ? "文件回填" : "实时 + 回填已对账"}
            </dd>
          </dl>
          <dl className="kv">
            <dt>会话文件</dt>
            <dd title={session.file_path ?? ""}>{session.file_path ?? "—"}</dd>
            <dt>探针版本</dt>
            <dd>{probe?.probe_version ?? "—"}</dd>
            <dt>累计丢弃</dt>
            <dd style={{ color: (probe?.dropped_count ?? 0) > 0 ? "var(--err)" : undefined }}>
              {probe?.dropped_count ?? 0}
            </dd>
          </dl>
          <div className="metrics" style={{ gap: "0 26px" }}>
            <div className="metric">
              <span className="label">消息</span>
              <span className="v">{session.message_count}</span>
            </div>
            <div className="metric">
              <span className="label">Turn</span>
              <span className="v">{session.turn_count}</span>
            </div>
            <div className="metric">
              <span className="label">工具</span>
              <span className="v">{session.tool_call_count}</span>
            </div>
            <div className="metric">
              <span className="label">输入 token</span>
              <span className="v up">↑ {formatTokens(session.tokens_in)}</span>
            </div>
            <div className="metric">
              <span className="label">输出 token</span>
              <span className="v down">↓ {formatTokens(session.tokens_out)}</span>
            </div>
            <div className="metric">
              <span className="label">成本</span>
              <span className="v cost">$ {formatCost(session.cost)}</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <Timeline sessionId={id} initialEvents={events} initialTurns={turns} />
      </div>

      <div className="notice" style={{ marginTop: 14 }}>
        <span className="ic">◌</span>
        <div>
          <b style={{ color: "var(--fg)" }}>取不到的数据会明说</b>：
          <span className="badge plain">响应正文</span> 由流式事件重建（钩子不给原始字节）；
          <span className="badge plain">请求 / 响应配对</span> 按会话内顺序关联（无共享请求 ID，M3 落地）；
          <span className="badge plain">消息树与消息全文</span> 来自会话文件回填（M2 落地）；
          <span className="badge plain">探针启动前的事件</span> 只能靠回填补齐。
          当前页面是 M1 的原始事件流：首屏由服务端渲染，其后新事件经 SSE 追加，不刷新页面
          （条数以时间线标题为准）。
        </div>
      </div>

      <div className="notice readonly" style={{ marginTop: 14 }}>
        <span className="ic">◍</span>
        <div>本页所有控件只影响显示：无处可删、无处可改。工具不会重放，会话不会被续写。</div>
      </div>
    </div>
  );
}
