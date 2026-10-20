"use client";

import { clockTime, formatBytes, formatCost, formatDuration, formatTokens } from "@/lib/format.ts";
import { CATEGORY_LABELS, type TimelineFilters } from "@/lib/filters.ts";
import type { SessionStream, StreamCategory, StreamRow, TurnWindow } from "@/lib/stream.ts";
import { displayState } from "@/lib/session-view.ts";
import type { EventRow, SessionListItem, SessionStreamData } from "@/lib/types.ts";
import { RelativeTime } from "./relative-time.tsx";

export type { TimelineFilters };
export { CATEGORY_LABELS };

interface SessionTimelineProps {
  session: SessionListItem;
  data: SessionStreamData | null;
  stream: SessionStream | null;
  turnWindow: TurnWindow | null;
  filters: TimelineFilters;
  loading: boolean;
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

/** 右侧会话头 + 分组筛选 + 时间线。Turn 倒序显示，分页按钮在底部。 */
export function SessionTimeline({
  session,
  data,
  stream,
  turnWindow,
  filters,
  loading,
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
  const state = displayState(session);
  const stateLabel =
    state === "active" ? "进行中" : state === "idle" ? "空闲" : state === "ended" ? "已结束" : "状态未知";
  const stateClass = state === "active" ? "badge ok" : state === "idle" ? "badge warn" : "badge";
  // 回填会话只知道文件里有什么，不知道运行状态；两个徽章不重复出现
  const reconciled = state !== "unreconciled";
  const model = latestEventValue(data?.events ?? [], "model_select", "model");
  const thinking = latestEventValue(data?.events ?? [], "thinking_level_select", "level");
  const cacheRead = data?.turns.reduce((sum, turn) => sum + (turn.cache_read ?? 0), 0) ?? 0;
  const cacheWrite = data?.turns.reduce((sum, turn) => sum + (turn.cache_write ?? 0), 0) ?? 0;
  const counts = countRows(stream);
  const shownTurns = turnWindow === null ? [] : [...turnWindow.turns].reverse();
  const allOpen = shownTurns.length > 0 && shownTurns.every((turn) => openTurns.has(turn.key));
  const truncated = data === null ? [] : truncationNotes(data);
  const file = data?.session.file_path ?? session.file_path;
  const fileName = file === null ? "—" : file.split("/").pop() ?? file;

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
          {reconciled ? (
            <>
              <span className={stateClass}>{stateLabel}</span>
              <span className="badge info">已对账</span>
            </>
          ) : (
            <span className="badge warn">未对账</span>
          )}
          <span className="sh-actions">
            <button className="btn sm" onClick={onRefresh} disabled={loading}>
              {loading ? "读取中…" : "刷新"}
            </button>
          </span>
        </div>
        <div className="sh-sub">
          <span className="m">
            模型 <b>{model ?? "—"}</b>
          </span>
          <span className="m">
            思考 <b>{thinking ?? "—"}</b>
          </span>
          <span className="m">
            更新 <b>
              <RelativeTime value={session.last_activity_at} />
            </b>
          </span>
          <span className="m file" title={file ?? ""}>
            {fileName}
          </span>
          <span className="m">
            条目 <b>{data?.totals.messages ?? session.message_count}</b>
          </span>
          <span
            className="m"
            title={`时间线按用户消息分组，这里是分组数；库里一共 ${session.turn_count} 个模型 Turn`}
          >
            Turn <b>{stream?.turns.length ?? session.turn_count}</b>
          </span>
          <span className="m">
            工具 <b>{data?.totals.tools ?? session.tool_call_count}</b>
          </span>
          <span className="m">
            ↑ <b>{formatTokens(session.tokens_in)}</b>
          </span>
          <span className="m">
            ↓ <b>{formatTokens(session.tokens_out)}</b>
          </span>
          <span className="m" title={`缓存读取 ${cacheRead} / 写入 ${cacheWrite}`}>
            缓存 <b>{formatTokens(cacheRead)}</b>
            {cacheWrite > 0 ? <span className="faint"> / {formatTokens(cacheWrite)}</span> : null}
          </span>
          <span className="m">
            $ <b>{formatCost(session.cost)}</b>
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

      <div className="tl-scroll">
        <div className="tl">
          {error !== null ? (
            <div className="notice err tl-note">
              <span className="ic">!</span>
              <div>{error}</div>
            </div>
          ) : null}

          {data !== null && data.totals.events === 0 && data.totals.messages > 0 ? (
            <div className="notice tl-note">
              <span className="ic">◌</span>
              <div>
                <b style={{ color: "var(--fg)" }}>这个会话没有钩子事件</b>
                ：它产生于安装探针之前。时间线完全来自会话文件，所以没有请求、工具起止等事件行。
              </div>
            </div>
          ) : null}

          {truncated.length > 0 ? (
            <div className="notice warn tl-note">
              <span className="ic">◌</span>
              <div>
                库里的数据超过单页取数上限，时间线只显示了最近的一部分：
                {truncated.join("；")}。
              </div>
            </div>
          ) : null}

          {data === null ? (
            <div className="empty" style={{ padding: "60px 12px" }}>
              {loading ? "正在读取会话文件…" : "没有读到这个会话的数据。"}
            </div>
          ) : stream === null || turnWindow === null ? (
            <div className="empty" style={{ padding: "60px 12px" }}>
              正在整理时间线…
            </div>
          ) : stream.turns.length === 0 && stream.prelude === null ? (
            <div className="empty" style={{ padding: "60px 12px" }}>
              这个会话还没有可显示的条目。
            </div>
          ) : (
            <>
              <div className="tl-top">
                <span>
                  最近 {turnWindow.turns.length} 个 Turn
                </span>
                <span className="faint">
                  · 共 {turnWindow.total} 个 · {data.totals.messages} 条
                </span>
                <span className="spacer" />
                <span>点击 Turn 展开 · 进行中自动展开</span>
              </div>

              {shownTurns.map((turn) => {
                const open = openTurns.has(turn.key);
                const rows = turn.rows.filter(
                  (row) => filters[row.category] && (filters.branch || row.onCurrentBranch),
                );
                return (
                  <div
                    className={`turn${turn.running ? " running" : ""}${turn.failed ? " failed" : ""}${
                      open ? " open" : ""
                    }`}
                    key={turn.key}
                  >
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
                        {turn.failed ? <span className="badge err sm">失败</span> : null}
                        {turn.running ? <span className="badge ok sm">进行中</span> : null}
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
                          <TimelineRow
                            key={row.key}
                            row={row}
                            showThink={filters.think}
                            onDetail={onDetail}
                          />
                        ))
                      )}
                    </div>
                  </div>
                );
              })}

              {turnWindow.hasEarlier ? (
                <div className="load-earlier">
                  <button className="btn" onClick={onLoadEarlier}>
                    加载更早的 20 个 Turn
                  </button>
                </div>
              ) : null}

              {turnWindow.prelude !== null ? (
                <div
                  className={`turn${openTurns.has(turnWindow.prelude.key) ? " open" : ""}`}
                  key={turnWindow.prelude.key}
                >
                  <button
                    className="turn-head"
                    aria-expanded={openTurns.has(turnWindow.prelude.key)}
                    onClick={() => onToggleTurn(turnWindow.prelude?.key ?? "")}
                  >
                    <span className="twist">{openTurns.has(turnWindow.prelude.key) ? "▾" : "▸"}</span>
                    <span className="idx">会话前</span>
                    <span className="sum">{turnWindow.prelude.summary}</span>
                    <span className="stats">
                      <span>{clockTime(turnWindow.prelude.startedAt)}</span>
                      <span>{turnWindow.prelude.rows.length} 条</span>
                    </span>
                  </button>
                  <div className="turn-body">
                    {turnWindow.prelude.rows
                      .filter((row) => filters[row.category] && (filters.branch || row.onCurrentBranch))
                      .map((row) => (
                        <TimelineRow
                          key={row.key}
                          row={row}
                          showThink={filters.think}
                          onDetail={onDetail}
                        />
                      ))}
                  </div>
                </div>
              ) : null}

              {!turnWindow.hasEarlier ? (
                <div className="tl-end">
                  已到最早 · 共 {turnWindow.total} 个 Turn
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
  const hasDetail =
    row.entryId !== null || row.toolCallId !== null || row.requestSeq !== null || row.eventId !== null;

  return (
    <div className={kind.className}>
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
              {row.text !== null ? <span className="cmd">{row.text}</span> : null}
              {row.toolError ? <span className="badge err sm">失败</span> : <span className="badge ok sm">成功</span>}
              {row.durationMs !== null ? <span className="faint">{formatDuration(row.durationMs)}</span> : null}
            </div>
            {row.resultPreview !== null && row.resultPreview !== "" ? (
              <pre className={`out${row.toolError ? " err" : ""}`}>{row.resultPreview}</pre>
            ) : null}
          </>
        ) : row.kind === "pending" ? (
          <span className="pending">
            <span className="pulse" />
            {row.text ?? "等待助手写入会话文件…"}（不显示流式正文）
          </span>
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
            {row.kind === "request" ? (
              <div className="faint" style={{ fontSize: 10 }}>
                请求 #{row.requestSeq} · {formatBytes(row.payloadBytes)}（脱敏）
              </div>
            ) : null}
            {row.kind === "response" ? (
              <div className="faint" style={{ fontSize: 10 }}>
                响应 #{row.requestSeq}
                {row.durationMs === null ? "" : ` · ${formatDuration(row.durationMs)}`}
              </div>
            ) : null}
            {row.kind === "event" ? (
              <div className="faint" style={{ fontSize: 10 }}>
                {row.fromFile ? "来自会话文件" : "钩子事件，文件里没有"}
              </div>
            ) : null}
            {row.kind === "system" ? (
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
    case "system":
      return { className: "entry sys", key: "sys" };
    default:
      return { className: "entry ev", key: "ev" };
  }
}

function countRows(stream: SessionStream | null): Record<StreamCategory, number> {
  const counts: Record<StreamCategory, number> = {
    msg: 0,
    session: 0,
    run: 0,
    tool: 0,
    model: 0,
    probe: 0,
  };
  if (stream === null) return counts;
  const turns = stream.prelude === null ? stream.turns : [...stream.turns, stream.prelude];
  for (const turn of turns) {
    for (const row of turn.rows) counts[row.category] += 1;
  }
  return counts;
}

function truncationNotes(data: SessionStreamData): string[] {
  const notes: string[] = [];
  if (data.messages.length < data.totals.messages) {
    notes.push(`条目 ${data.messages.length} / ${data.totals.messages}`);
  }
  if (data.turns.length < data.totals.turns) {
    notes.push(`Turn ${data.turns.length} / ${data.totals.turns}`);
  }
  if (data.events.length < data.totals.events) {
    notes.push(`事件 ${data.events.length} / ${data.totals.events}`);
  }
  if (data.tools.length < data.totals.tools) {
    notes.push(`工具 ${data.tools.length} / ${data.totals.tools}`);
  }
  if (data.requests.length < data.totals.requests) {
    notes.push(`请求 ${data.requests.length} / ${data.totals.requests}`);
  }
  return notes;
}

function latestEventValue(events: EventRow[], eventType: string, field: string): string | null {
  let best: EventRow | null = null;
  for (const event of events) {
    if (event.event_type !== eventType) continue;
    if (best === null || compareEvents(event, best) > 0) best = event;
  }
  if (best === null) return null;
  const payload = best.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function compareEvents(a: EventRow, b: EventRow): number {
  const at = (a.occurred_at ?? "").localeCompare(b.occurred_at ?? "");
  return at !== 0 ? at : a.id - b.id;
}
