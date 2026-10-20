"use client";

import { useMemo, useState } from "react";

import { shortId } from "@/lib/format.ts";
import { displayState, groupByProject } from "@/lib/session-view.ts";
import type { SessionListItem } from "@/lib/types.ts";
import { RelativeTime } from "./relative-time.tsx";

interface SessionSidebarProps {
  sessions: SessionListItem[];
  total: number;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}

/** 左栏：按项目分组的会话列表 + 本地搜索。只切换当前会话，不提供任何写操作。 */
export function SessionSidebar({
  sessions,
  total,
  selectedId,
  onSelect,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return sessions;
    return sessions.filter((session) =>
      `${session.session_id} ${session.cwd} ${session.name ?? ""} ${session.first_user_text ?? ""} ${session.file_path ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [sessions, query]);

  const groups = useMemo(() => groupByProject(filtered), [filtered]);
  const shownTotal = total > sessions.length ? `${sessions.length} / ${total}` : String(total);

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <span className="label">会话</span>
        <span className="count" title={total > sessions.length ? `列表最多取 ${sessions.length} 个，库里有 ${total} 个` : undefined}>
          {shownTotal} 个
        </span>
      </div>

      <div className="sb-search">
        <label className="input">
          <span style={{ color: "var(--fg-3)" }}>⌕</span>
          <input
            data-sb-search
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索摘要、项目、会话 ID…"
          />
        </label>
      </div>

      <div className="sb-scroll">
        {groups.map((group) => (
          <div className="proj" key={group.cwd}>
            <div className="proj-head">
              <span className="p" title={group.cwd}>
                {group.cwd}
              </span>
              <span className="n">{group.sessions.length}</span>
            </div>
            {group.sessions.map((session) => {
              const state = displayState(session);
              const summary = session.name ?? session.first_user_text;
              return (
                <a
                  className={`sess${session.session_id === selectedId ? " on" : ""}`}
                  key={session.session_id}
                  href={`?session=${encodeURIComponent(session.session_id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onSelect(session.session_id);
                  }}
                  title={`${session.session_id}\n${session.cwd}`}
                >
                  <div className="sess-row">
                    <span className={`dot${state === "active" ? "" : state === "idle" ? " idle" : " ended"}`} />
                    <span className="sum" style={summary === null ? { color: "var(--fg-3)" } : undefined}>
                      {summary ?? "（文件里没有会话名，也还没有用户消息）"}
                    </span>
                  </div>
                  <div className="sess-meta">
                    <span>{shortId(session.session_id)}</span>
                    <span title="模型 Turn 数；时间线按用户消息分组，显示的轮数更少">
                      {session.turn_count} Turn
                    </span>
                    <span title={session.last_activity_at ?? ""}>
                      <RelativeTime value={session.last_activity_at} />
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        ))}

        {groups.length === 0 ? (
          <div className="empty" style={{ padding: "24px 12px" }}>
            {sessions.length === 0 ? "还没有任何会话数据。" : "没有匹配的会话。"}
          </div>
        ) : null}
      </div>

      <div className="sb-foot">
        <span className="dot-sm" style={{ color: "var(--green)" }} />
        只读 · 不删除、不改名
      </div>
    </aside>
  );
}
