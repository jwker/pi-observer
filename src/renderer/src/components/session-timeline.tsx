"use client";

import { useLayoutEffect, useRef } from "react";

import { clockTime, formatBytes, formatCost, formatDuration, formatTokens } from "@renderer/lib/format.ts";
import { CATEGORY_LABELS, type TimelineFilters } from "@renderer/lib/filters.ts";
import type { StreamCategory, StreamRow, StreamTurn } from "@shared/types.ts";
import type { SessionListItem, SessionWindow } from "@shared/types.ts";
import { RelativeTime } from "./relative-time.tsx";

export type { TimelineFilters };
export { CATEGORY_LABELS };

interface SessionTimelineProps {
  session: SessionListItem;
  data: SessionWindow | null;
  filters: TimelineFilters;
  loading: boolean;
  loadingEarlier: boolean;
  error: string | null;
  openTurns: Set<string>;
  onToggleCategory: (category: StreamCategory) => void;
  onToggleThink: () => void;
  onToggleBranch: () => void;
  onToggleTurn: (key: string) => void;
  onExpandAll: () => void;
  onLoadEarlier: () => void;
  onRefresh: () => void;
  onDetail: (row: StreamRow) => void;
}

/** 右侧会话头 + 分组筛选 + 时间线。Turn 倒序显示，「加载更早」在底部。 */
export function SessionTimeline({
  session,
  data,
  filters,
  loading,
  loadingEarlier,
  error,
  openTurns,
  onToggleCategory,
  onToggleThink,
  onToggleBranch,
  onToggleTurn,
  onExpandAll,
  onLoadEarlier,
  onRefresh,
  onDetail,
}: SessionTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const counts = countRows(data);
  const shownTurns = data === null ? [] : [...data.turns].reverse();
  const allOpen = shownTurns.length > 0 && shownTurns.every((turn) => openTurns.has(turn.key));
  const file = data?.session.file_path ?? session.file_path;
  const fileName = file === null ? "—" : file.split("/").pop() ?? file;
  const totals = data?.totals;

  return (
    <main className="main">
      <div className="session-head">
        <div className="sh-line">
          <span className="sh-cwd" title={session.cwd}>
            {session.cwd || "（未知工作目录）"}
          </span>
          <span className="sep">/</span>
          <span className="sh-id" title={session.session_id}>
            {session.session_id}
          </span>
          <span className="sh-actions">
            <button className="btn sm" onClick={onRefresh} disabled={loading}>
              {loading ? "读取中…" : "刷新"}
            </button>
          </span>
        </div>
        <div className="sh-sub">
          <span className="m">
            更新 <b>
              <RelativeTime value={session.last_activity_at} />
            </b>
          </span>
          <span className="m file" title={file ?? ""}>
            {fileName}
          </span>
          <span className="m">
            条目 <b>{totals?.entries ?? "—"}</b>
          </span>
          <span className="m" title="一条助手消息 = 一个模型 Turn">
            Turn <b>{totals?.turns ?? "—"}</b>
          </span>
          <span className="m">
            工具 <b>{totals?.tools ?? "—"}</b>
          </span>
          <span className="m" title="对上了助手消息的 provider 请求文件数">
            请求 <b>{totals?.requests ?? "—"}</b>
          </span>
          <span className="m">
            ↑ <b>{formatTokens(totals?.tokens_in ?? null)}</b>
          </span>
          <span className="m">
            ↓ <b>{formatTokens(totals?.tokens_out ?? null)}</b>
          </span>
          <span
            className="m"
            title={`缓存读取 ${formatTokens(totals?.cache_read ?? null)} / 写入 ${formatTokens(totals?.cache_write ?? null)}`}
          >
            缓存 <b>{formatTokens(totals?.cache_read ?? null)}</b>
            {(totals?.cache_write ?? 0) > 0 ? (
              <span className="faint"> / {formatTokens(totals?.cache_write ?? null)}</span>
            ) : null}
          </span>
          <span className="m">
            $ <b>{formatCost(totals?.cost ?? null)}</b>
          </span>
        </div>
      </div>

      <div className="filterbar">
        <div className="fb-row">
          <span className="fb-label">显示</span>
          {CATEGORY_LABELS.map(([category, label]) => (
            <button
              key={category}
              className={`chip${filters[category] ? " on" : ""}`}
              data-cat-chip={category}
              onClick={() => onToggleCategory(category)}
              disabled={counts[category] === 0}
              title={counts[category] === 0 ? "这个会话没有这类数据" : undefined}
            >
              {label} <span className="n">{counts[category]}</span>
            </button>
          ))}
          <span className="fb-spacer" />
          <button
            className={`chip${filters.think ? " on" : ""}`}
            onClick={onToggleThink}
            title="显示或隐藏思考过程（T）"
          >
            思考
          </button>
          <button
            className={`chip${filters.branch ? " on alt" : ""}`}
            onClick={onToggleBranch}
            title="显示不在当前分支上的条目（B）"
          >
            其它分支
          </button>
          <button className="btn sm" onClick={onExpandAll}>
            {allOpen ? "收起全部" : "展开全部"}
          </button>
        </div>
      </div>

      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl">
          {error !== null ? (
            <div className="notice err tl-note">
              <span className="ic">!</span>
              <div>{error}</div>
            </div>
          ) : null}

          {data === null ? (
            <div className="empty" style={{ padding: "60px 12px" }}>
              {loading ? "正在读取会话文件…" : "没有读到这个会话的文件。"}
            </div>
          ) : shownTurns.length === 0 && data.prelude === null ? (
            <div className="empty" style={{ padding: "60px 12px" }}>
              这个会话还没有可显示的条目。
            </div>
          ) : (
            <>
              <div className="tl-top">
                <span>
                  最近 {shownTurns.length} 个 Turn
                </span>
                <span className="faint">
                  · 共 {data.total} 个 · {data.totals.entries} 条
                </span>
                <span className="spacer" />
                <span>点击 Turn 展开</span>
              </div>

              {shownTurns.map((turn) => {
                const open = openTurns.has(turn.key);
                const rows = turn.rows.filter(
                  (row) => filters[row.category] && (filters.branch || row.onCurrentBranch),
                );
                return (
                  <div className={`turn${open ? " open" : ""}`} key={turn.key}>
                    <button
                      className="turn-head"
                      aria-expanded={open}
                      onClick={() => onToggleTurn(turn.key)}
                    >
                      <span className="twist">{open ? "▾" : "▸"}</span>
                      <span className="idx">
                        {turn.index === null ? "会话前" : `Turn ${turn.index}`}
                      </span>
                      <span className="sum">{turn.summary}</span>
                      <span className="stats">
                        <span>{clockTime(turn.startedAt)}</span>
                        <span>{turn.stats.toolCount} 工具</span>
                        <span>
                          ↑ {formatTokens(turn.stats.tokensIn)} ↓ {formatTokens(turn.stats.tokensOut)}
                        </span>
                        <span>$ {formatCost(turn.stats.cost)}</span>
                      </span>
                    </button>
                    <div className="turn-body">
                      {rows.length === 0 ? (
                        <div className="empty">这一类行被筛选隐藏了。</div>
                      ) : (
                        rows.map((row) => (
                          <TimelineRow key={row.key} row={row} showThink={filters.think} onDetail={onDetail} />
                        ))
                      )}
                    </div>
                  </div>
                );
              })}

              {data.hasEarlier ? (
                <div className="load-earlier">
                  <button className="btn" onClick={onLoadEarlier} disabled={loadingEarlier}>
                    {loadingEarlier ? "读取中…" : "加载更早的 20 个 Turn"}
                  </button>
                </div>
              ) : null}

              {data.prelude !== null ? (
                <div className={`turn${openTurns.has(data.prelude.key) ? " open" : ""}`} key={data.prelude.key}>
                  <button
                    className="turn-head"
                    aria-expanded={openTurns.has(data.prelude.key)}
                    onClick={() => onToggleTurn(data.prelude?.key ?? "")}
                  >
                    <span className="twist">{openTurns.has(data.prelude.key) ? "▾" : "▸"}</span>
                    <span className="idx">会话前</span>
                    <span className="sum">{data.prelude.summary}</span>
                    <span className="stats">
                      <span>{clockTime(data.prelude.startedAt)}</span>
                      <span>{data.prelude.rows.length} 条</span>
                    </span>
                  </button>
                  <div className="turn-body">
                    {data.prelude.rows
                      .filter((row) => filters[row.category] && (filters.branch || row.onCurrentBranch))
                      .map((row) => (
                        <TimelineRow key={row.key} row={row} showThink={filters.think} onDetail={onDetail} />
                      ))}
                  </div>
                </div>
              ) : null}

              {!data.hasEarlier ? (
                <div className="tl-end">
                  已到最早 · 共 {data.total} 个 Turn
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function TimelineRow({
  row,
  showThink,
  onDetail,
}: {
  row: StreamRow;
  showThink: boolean;
  onDetail: (row: StreamRow) => void;
}) {
  const kind = rowKindClass(row);
  const hasDetail = row.entryId !== null;

  return (
    <div className={kind.className} data-row-key={row.key}>
      {hasDetail ? (
        <button className="more" onClick={() => onDetail(row)} title="详情" aria-label="详情">
          more
        </button>
      ) : (
        <span />
      )}
      <span className="t">{clockTime(row.at)}</span>
      <span className={`k ${kind.key}`}>{row.label}</span>
      <div className="b">
        {row.kind === "tool" ? (
          <>
            <div className="tr-head">
              <span className="name">{row.toolName}</span>
              {row.toolError ? (
                <span className="badge err sm">失败</span>
              ) : (
                <span className="badge ok sm">成功</span>
              )}
              {row.durationMs !== null ? (
                <span className="faint">{formatDuration(row.durationMs)}</span>
              ) : null}
            </div>
            {row.text !== null && row.text !== "" ? (
              <pre className={`out${row.toolError ? " err" : ""}`}>{row.text}</pre>
            ) : null}
          </>
        ) : (
          <>
            <div className="txt">{row.text ?? "—"}</div>
            {row.kind === "assistant" && showThink && row.thinking !== null ? (
              <details className="think">
                <summary>思考 · {row.thinking.length} 字</summary>
                <div className="think-body">{row.thinking}</div>
              </details>
            ) : null}
            {row.kind === "assistant" && row.toolNames.length > 0 ? (
              <div className="tchips">
                {row.toolNames.map((name, index) => (
                  <span className="tchip" key={`${row.key}:tool:${index}`}>
                    → {name}
                  </span>
                ))}
              </div>
            ) : null}
            {row.requestId !== null ? (
              <div className="faint" style={{ fontSize: 10 }}>
                请求 {row.requestId}
                {row.requestBytes !== null ? ` · ${formatBytes(row.requestBytes)}` : ""}
                {row.requestPath !== null ? (
                  <span title={row.requestPath}> · {row.requestPath.split("/").slice(-2).join("/")}</span>
                ) : null}
              </div>
            ) : null}
            {row.kind === "note" ? (
              <div className="faint" style={{ fontSize: 10 }}>
                来自会话文件
              </div>
            ) : null}
          </>
        )}
        {!row.onCurrentBranch ? (
          <span className="badge sm" style={{ marginLeft: 6 }}>
            其它分支
          </span>
        ) : null}
        {row.forkPoint ? (
          <span className="badge plain sm" style={{ marginLeft: 6 }} title="这个条目有多个子条目">
            分叉点
          </span>
        ) : null}
      </div>
    </div>
  );
}

function rowKindClass(row: StreamRow): { className: string; key: string } {
  switch (row.kind) {
    case "user":
      return { className: "entry user", key: "user" };
    case "assistant":
      return { className: "entry a", key: "a" };
    case "tool":
      return { className: "entry tool", key: "tool" };
    default:
      return { className: "entry ev", key: "ev" };
  }
}

function countRows(data: SessionWindow | null): Record<StreamCategory, number> {
  const counts: Record<StreamCategory, number> = {
    msg: 0,
    session: 0,
    model: 0,
    tool: 0,
  };
  if (data === null) return counts;
  const turns: StreamTurn[] = data.prelude === null ? data.turns : [...data.turns, data.prelude];
  for (const turn of turns) {
    for (const row of turn.rows) counts[row.category] += 1;
  }
  return counts;
}
