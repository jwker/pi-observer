"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { clockTime, dateTime, formatCost, formatTokens, relativeTime, shortId } from "@/lib/format.ts";
import {
  STATE_META,
  SOURCE_LABELS,
  countByState,
  displayState,
  filterSessions,
  groupByProject,
} from "@/lib/session-view.ts";
import type { OverviewStats, SessionListItem } from "@/lib/types.ts";
import { useNow, useStreamEvent } from "./hooks.ts";

interface SessionListProps {
  initial: SessionListItem[];
  initialStats: OverviewStats;
  /** 库里一共多少个会话（列表最多取 200 个） */
  totalSessions: number;
}

const STATE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["all", "全部"],
  ["active", STATE_META.active.label],
  ["idle", STATE_META.idle.label],
  ["ended", STATE_META.ended.label],
  ["unreconciled", STATE_META.unreconciled.label],
];

const SOURCE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["all", "全部来源"],
  ["live", SOURCE_LABELS.live ?? "实时"],
  ["backfill", SOURCE_LABELS.backfill ?? "回填"],
  ["merged", SOURCE_LABELS.merged ?? "已对账"],
];

export function SessionList({ initial, initialStats, totalSessions }: SessionListProps) {
  const [sessions, setSessions] = useState<SessionListItem[]>(initial);
  const [stats, setStats] = useState<OverviewStats>(initialStats);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const now = useNow(1000);

  // 任何一批写入后服务端都会广播；列表与概览一起重拉，避免两者对不上
  useStreamEvent((event) => {
    if (event !== "session.updated") return;
    fetch("/api/sessions")
      .then((response) => response.json())
      .then((json: { sessions?: SessionListItem[]; stats?: OverviewStats }) => {
        if (json.sessions) setSessions(json.sessions);
        if (json.stats) setStats(json.stats);
      })
      .catch(() => {
        // 拉取失败保持旧数据
      });
  });

  const filtered = useMemo(
    () => filterSessions(sessions, { query, state: stateFilter, source: sourceFilter }),
    [sessions, query, stateFilter, sourceFilter],
  );
  const grouped = useMemo(() => groupByProject(filtered), [filtered]);
  const counts = useMemo(() => countByState(sessions), [sessions]);

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
            <span className="v up">{counts.active}</span>
          </div>
          <div className="metric">
            <span className="label">会话总数</span>
            <span className="v" title={`库里的会话总数；本页最多显示 ${initial.length} 个`}>
              {totalSessions}
            </span>
          </div>
          <div className="metric">
            <span className="label">今日事件</span>
            <span className="v" title="今天 0 点起服务端收到的实时事件数；回填不写事件">
              {stats.events_today}
            </span>
          </div>
          <div className="metric">
            <span className="label">今日 token</span>
            <span className="v down" title="按 turn 的开始时间落在今天的合计">
              ↑ {formatTokens(stats.tokens_in_today)} / ↓ {formatTokens(stats.tokens_out_today)}
            </span>
          </div>
          <div className="metric">
            <span className="label">今日成本</span>
            <span className="v cost">$ {formatCost(stats.cost_today)}</span>
          </div>
          <div className="metric">
            <span className="label">累计丢弃</span>
            <span
              className="v"
              style={{ color: stats.dropped_total > 0 ? "var(--err)" : undefined }}
              title="探针自报的累计丢弃条数（不是今日）"
            >
              {stats.dropped_total}
            </span>
          </div>
          <div className="metric">
            <span className="label">最近对账</span>
            <span
              className="v faint"
              style={{ fontSize: 12 }}
              title={
                stats.last_reconciled_at === null
                  ? "还没有会话被对账过；agent_settled 后的对账在 M2-5 落地"
                  : dateTime(stats.last_reconciled_at)
              }
            >
              {stats.last_reconciled_at === null ? "—" : clockTime(stats.last_reconciled_at)}
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
              placeholder="搜索会话 ID、项目路径、首条用户消息…"
            />
          </label>
          <div className="seg">
            {STATE_OPTIONS.map(([value, label]) => (
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
            {SOURCE_OPTIONS.map(([value, label]) => (
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
            <span title="会话文件里没有会话名，这里显示这一会话的第一条用户消息">首条用户消息 · 状态</span>
            <span className="num">消息</span>
            <span className="num">Turn</span>
            <span className="num">工具</span>
            <span className="num">token</span>
            <span className="num">成本</span>
            <span className="num">最后活跃</span>
          </div>

          {grouped.map((group) => (
            <div className="group" key={group.cwd}>
              <div className="group-head">
                <span className="path">{group.cwd}</span>
                <span className="faint">{group.sessions.length} 个会话</span>
              </div>
              {group.sessions.map((session) => {
                const state = STATE_META[displayState(session)];
                const summary = session.name ?? session.first_user_text;
                return (
                  <Link className="row session hover" key={session.session_id} href={`/sessions/${session.session_id}`}>
                    <span className="badge plain">
                      <span className="dot-sm" style={{ color: state.dot }} />
                    </span>
                    <span className="nowrap" style={{ color: "var(--fg-1)" }} title={session.session_id}>
                      {shortId(session.session_id)}
                    </span>
                    <span className="col-grow session-summary" title={summary ?? "文件里没有会话名，也还没有用户消息"}>
                      <span className="txt" style={{ color: summary === null ? "var(--fg-3)" : "var(--fg)" }}>
                        {summary ?? "—"}
                      </span>
                      <span className="sep faint">·</span>
                      <span className={state.className}>{state.label}</span>
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
                ? "还没有任何会话数据：会话文件目录里没有读到 .jsonl，探针也还没收到过事件。"
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
          <code>agent_settled</code> 且 60 秒无新事件；<span className="badge">已结束</span> 探针报告会话进程已退出。
          <span className="badge plain">未对账</span> 只有会话文件回填、从没收到过实时事件——文件里没有进程或 agent
          的状态，所以不能算「空闲」；对账（<code>agent_settled</code> 后的推进）在 M2-5 落地。
          来源标记：<code>live</code> 实时推送、<code>backfill</code> 从会话文件回填、<code>merged</code> 已对账。
          <br />
          概览按<strong>本机时区的今天 0 点</strong>算：今日事件只统计实时事件（回填不写事件），今日 token / 成本按 turn
          的开始时间求和。列表里的「首条用户消息」是这一会话的第一条 <code>role=user</code> 正文——Pi
          的会话文件头部没有会话名字段。
        </div>
      </div>
    </>
  );
}
