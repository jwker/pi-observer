"use client";

import { useMemo, useState } from "react";

import { formatBytes, shortId } from "@/lib/format.ts";
import { groupByProject } from "@/lib/session-list.ts";
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
      `${session.session_id} ${session.cwd} ${session.first_user_text ?? ""} ${session.file_path ?? ""}`
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
        <span className="count">{shownTotal} 个</span>
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
              const summary = session.first_user_text;
              return (
                <a
                  className={`sess${session.session_id === selectedId ? " on" : ""}`}
                  key={session.session_id}
                  href={`?session=${encodeURIComponent(session.session_id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onSelect(session.session_id);
                  }}
                  title={`${session.session_id}\n${session.cwd}\n${session.file_path}`}
                >
                  <div className="sess-row">
                    <span
                      className="sum"
                      style={summary === null ? { color: "var(--fg-3)" } : undefined}
                    >
                      {summary ?? "（文件里还没有用户消息）"}
                    </span>
                  </div>
                  <div className="sess-meta">
                    <span>{shortId(session.session_id)}</span>
                    <span title={session.file_path ?? ""}>{formatBytes(session.size_bytes)}</span>
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
            {sessions.length === 0 ? "还没有任何会话文件。" : "没有匹配的会话。"}
          </div>
        ) : null}
      </div>

      <div className="sb-foot">
        <span className="dot-sm" style={{ color: "var(--green)" }} />
        只读 · 数据来自会话文件
      </div>
    </aside>
  );
}
