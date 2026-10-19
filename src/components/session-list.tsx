"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { formatCost, formatTokens, relativeTime, shortId } from "@/lib/format.ts";
import type { SessionRow } from "@/lib/types.ts";
import { useNow, useStreamEvent } from "./hooks.ts";

const STATE_LABELS: Record<string, { label: string; className: string; dot: string }> = {
  active: { label: "进行中", className: "badge ok", dot: "var(--green)" },
  idle: { label: "空闲", className: "badge warn", dot: "var(--amber)" },
  ended: { label: "已结束", className: "badge", dot: "var(--fg-3)" },
};

const SOURCE_LABELS: Record<string, string> = {
  live: "实时",
  backfill: "回填",
  merged: "已对账",
};

function stateOf(state: string) {
  return STATE_LABELS[state] ?? STATE_LABELS.ended;
}

export function SessionList({ initial }: { initial: SessionRow[] }) {
  const [sessions, setSessions] = useState<SessionRow[]>(initial);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const now = useNow(1000);

  // 任何一批写入后服务端都会广播；这里重新拉一次列表，避免自己做增量合并
  useStreamEvent((event) => {
    if (event !== "session.updated") return;
    fetch("/api/sessions")
      .then((response) => response.json())
      .then((json: { sessions?: SessionRow[] }) => setSessions(json.sessions ?? []))
      .catch(() => {
        // 拉取失败保持旧数据
      });
  });

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (stateFilter !== "all" && session.state !== stateFilter) return false;
      if (sourceFilter !== "all" && session.source !== sourceFilter) return false;
      if (needle === "") return true;
      const haystack = `${session.session_id} ${session.cwd} ${session.name ?? ""} ${session.file_path ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [sessions, query, stateFilter, sourceFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const session of filtered) {
      const key = session.cwd || "（未知工作目录）";
      const list = map.get(key);
      if (list) list.push(session);
      else map.set(key, [session]);
    }
    return [...map.entries()];
  }, [filtered]);

  const totals = useMemo(
    () =>
      sessions.reduce(
        (acc, session) => ({
          turns: acc.turns + session.turn_count,
          tools: acc.tools + session.tool_call_count,
          tokensIn: acc.tokensIn + session.tokens_in,
          tokensOut: acc.tokensOut + session.tokens_out,
          cost: acc.cost + session.cost,
          active: acc.active + (session.state === "active" ? 1 : 0),
        }),
        { turns: 0, tools: 0, tokensIn: 0, tokensOut: 0, cost: 0, active: 0 },
      ),
    [sessions],
  );

  return (
    <>
      <div className="notice readonly">
        <span className="ic">◍</span>
        <div>
          只读界面：不提供删除、隐藏、重命名等入口。数据来自 <code>~/.pi/agent/sessions/</code> 的会话文件与探针推送，不改动 Pi
          的任何数据。
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-body metrics">
          <div className="metric">
            <span className="label">活跃会话</span>
            <span className="v up">{totals.active}</span>
          </div>
          <div className="metric">
            <span className="label">会话总数</span>
            <span className="v">{sessions.length}</span>
          </div>
          <div className="metric">
            <span className="label">Turn</span>
            <span className="v">{totals.turns}</span>
          </div>
          <div className="metric">
            <span className="label">工具调用</span>
            <span className="v">{totals.tools}</span>
          </div>
          <div className="metric">
            <span className="label">token</span>
            <span className="v down">
              ↑ {formatTokens(totals.tokensIn)} / ↓ {formatTokens(totals.tokensOut)}
            </span>
          </div>
          <div className="metric">
            <span className="label">成本</span>
            <span className="v cost">$ {formatCost(totals.cost)}</span>
          </div>
          <div className="metric">
            <span className="label">今日事件</span>
            <span className="v faint" title="按日聚合要等 M2 的回填与统计，这里先不猜数">
              待 M2
            </span>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head">
          <span>会话</span>
          <span className="count">{filtered.length} 个</span>
        </div>

        <div className="panel-body toolbar">
          <label className="input">
            <span style={{ color: "var(--fg-3)" }}>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话 ID、项目路径、名称…"
            />
          </label>
          <div className="seg">
            {[
              ["all", "全部"],
              ["active", "进行中"],
              ["idle", "空闲"],
              ["ended", "已结束"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={stateFilter === value ? "on" : undefined}
                onClick={() => setStateFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="seg">
            {[
              ["all", "全部来源"],
              ["live", "实时"],
              ["backfill", "回填"],
              ["merged", "已对账"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={sourceFilter === value ? "on" : undefined}
                onClick={() => setSourceFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <span className="faint" style={{ fontSize: 11 }}>
            点击任意一行进入会话详情
          </span>
        </div>

        <div className="rows">
          <div className="row head session">
            <span />
            <span>会话</span>
            <span>名称 / 状态</span>
            <span className="num">消息</span>
            <span className="num">Turn</span>
            <span className="num">工具</span>
            <span className="num">token</span>
            <span className="num">成本</span>
            <span className="num">最后活跃</span>
          </div>

          {grouped.map(([cwd, rows]) => (
            <div className="group" key={cwd}>
              <div className="group-head">
                <span className="path">{cwd}</span>
                <span className="faint">{rows.length} 个会话</span>
              </div>
              {rows.map((session) => {
                const state = stateOf(session.state);
                return (
                  <Link className="row session hover" key={session.session_id} href={`/sessions/${session.session_id}`}>
                    <span className="badge plain">
                      <span className="dot-sm" style={{ color: state.dot }} />
                    </span>
                    <span className="nowrap" style={{ color: "var(--fg-1)" }} title={session.session_id}>
                      {shortId(session.session_id)}
                    </span>
                    <span className="col-grow">
                      <span style={{ color: "var(--fg)" }}>{session.name ?? "（未命名）"}</span>{" "}
                      <span className="faint">·</span> <span className={state.className}>{state.label}</span>{" "}
                      <span className="badge plain">{SOURCE_LABELS[session.source] ?? session.source}</span>
                    </span>
                    <span className="num">{session.message_count}</span>
                    <span className="num">{session.turn_count}</span>
                    <span className="num">{session.tool_call_count}</span>
                    <span className="num" style={{ color: "var(--green)" }}>
                      ↑ {formatTokens(session.tokens_in)}
                    </span>
                    <span className="num" style={{ color: "var(--amber)" }}>
                      {formatCost(session.cost)}
                    </span>
                    <span className="num faint">{relativeTime(session.last_activity_at, now)}</span>
                  </Link>
                );
              })}
            </div>
          ))}

          {grouped.length === 0 ? (
            <div className="empty">
              {sessions.length === 0
                ? "还没有任何会话数据。把探针接到 Pi 上一次请求后（或等 M2 的回填），这里就会出现会话。"
                : "没有匹配的会话。试试清空搜索或切换筛选。"}
            </div>
          ) : null}
        </div>
      </div>

      <div className="notice" style={{ marginTop: 14 }}>
        <span className="ic">i</span>
        <div>
          <b style={{ color: "var(--fg)" }}>状态口径</b>：<span className="badge ok">进行中</span> 收到{" "}
          <code>agent_start</code> 且尚未 <code>agent_settled</code>；<span className="badge warn">空闲</span> 已收到{" "}
          <code>agent_settled</code>；<span className="badge">已结束</span> 探针报告会话进程已退出。来源标记：<code>live</code>{" "}
          实时推送、<code>backfill</code> 从会话文件回填、<code>merged</code> 已对账（后两者在 M2 落地）。
        </div>
      </div>
    </>
  );
}
