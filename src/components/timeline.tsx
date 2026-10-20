"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";

import Link from "next/link";

import { clockTime, formatBytes, formatCost, formatDuration, formatTokens, previewJson, shortId } from "@/lib/format.ts";
import { groupTimeline, isRunning, latestProgress, summarizeTurn, type TimelineGroup } from "@/lib/timeline.ts";
import type { EventRow, TurnRow } from "@/lib/types.ts";
import { useStreamEvent } from "./hooks.ts";

interface TimelineProps {
  sessionId: string;
  initialEvents: EventRow[];
  initialTurns: TurnRow[];
  /** 嵌在会话详情页的标签页里时不再套一层 `.panel` */
  embedded?: boolean;
}

const LAYER_CLASS: Record<string, string> = {
  session: "session",
  agent: "agent",
  turn: "turn",
  message: "message",
  tool: "tool",
  provider: "provider",
};

/** 各类事件在时间线上的正文（尽量短，细节留给 M3 的详情页） */
function describeEvent(event: EventRow): { text: string; note?: string; code?: string } {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  switch (event.event_type) {
    case "turn_start":
      return {
        text: `turnIndex ${String(payload.turnIndex ?? "—")}`,
        note: "turnIndex 每次 agent_start 归零，故按运行序号 + Turn 分组",
      };
    case "turn_end": {
      const stop = typeof payload.stopReason === "string" ? payload.stopReason : "—";
      const entry = typeof payload.messageEntryId === "string" ? payload.messageEntryId : "—";
      const updates = typeof payload.updateCount === "number" ? payload.updateCount : 0;
      return {
        text: `stopReason: ${stop}`,
        note: `messageEntryId: ${entry} · 收到 ${updates} 次快照更新`,
      };
    }
    case "message_start":
      return { text: `role: ${String(payload.role ?? "—")}`, note: `turnIndex ${String(payload.turnIndex ?? "—")}` };
    case "tool_execution_start":
      return {
        text: `${String(payload.toolName ?? "tool")} ${previewJson(payload.args) ?? ""}`,
        note: `toolCallId ${String(payload.toolCallId ?? "—")}`,
      };
    case "tool_execution_end": {
      const isError = payload.isError === true;
      return {
        text: `${isError ? "失败" : "成功"} · ${formatDuration(typeof payload.durationMs === "number" ? payload.durationMs : null)}`,
        note: `toolCallId ${String(payload.toolCallId ?? "—")}`,
      };
    }
    case "message_progress":
      return { text: "", note: "流式快照（每 500 ms 覆盖同一行）" };
    case "session_shutdown":
      return { text: `reason: ${String(payload.reason ?? "—")}` };
    case "session_start":
      return {
        text: `reason: ${String(payload.reason ?? "—")}`,
        note: `探针 ${String(payload.probeVersion ?? "—")} · 实时正文${payload.liveText === false ? "关闭" : "开启"}`,
      };
    case "probe_health":
      return { text: payload.healthy === true ? "看板服务可达" : "看板服务不可达（探针仍在排队）" };
    case "agent_start":
      return { text: `runSeq ${String(payload.runSeq ?? "—")}` };
    case "agent_settled":
      return { text: payload.aborted === true ? "已中止" : "正常结束", note: "会话是否空闲以此为准" };
    case "session_info_changed":
      return { text: `名称 → ${payload.name === null ? "（清空）" : String(payload.name ?? "—")}` };
    case "provider_request": {
      const bytes = typeof payload.payloadBytes === "number" ? payload.payloadBytes : null;
      return {
        text: `${String(payload.provider ?? "—")} / ${String(payload.api ?? "—")} / ${String(payload.model ?? "—")}`,
        note: `payload ${formatBytes(bytes)}${payload.payloadTruncated === true ? "（已截断）" : ""}`,
      };
    }
    case "provider_response":
      return {
        text: `状态 ${String(payload.status ?? "—")}`,
        note: `请求 #${String(payload.requestSeq ?? "—")} · 响应头 ${Array.isArray(payload.headerNames) ? payload.headerNames.length : 0} 个`,
      };
    case "provider_response_unmatched":
      return { text: `状态 ${String(payload.status ?? "—")}`, note: "没有配对的请求记录" };
    case "model_select":
      return { text: `模型 → ${String(payload.model ?? "—")}`, note: `来源 ${String(payload.source ?? "—")}` };
    case "thinking_level_select":
      return {
        text: `思考等级 ${String(payload.previousLevel ?? "—")} → ${String(payload.level ?? "—")}`,
      };
    default:
      return { text: previewJson(event.payload) ?? "（无载荷）" };
  }
}

export function Timeline({ sessionId, initialEvents, initialTurns, embedded = false }: TimelineProps) {
  const [events, setEvents] = useState<EventRow[]>(initialEvents);
  const [turns, setTurns] = useState<TurnRow[]>(initialTurns);
  const [liveText, setLiveText] = useState(true);
  const [showThinking, setShowThinking] = useState(true);
  const [showTools, setShowTools] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [streaming, setStreaming] = useState(false);

  const refresh = useCallback(async () => {
    const lastId = events.length > 0 ? events[events.length - 1].id : 0;
    try {
      setStreaming(true);
      const [eventsResponse, turnsResponse] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events?after_id=${lastId}&limit=2000`),
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}/turns`),
      ]);
      const eventsJson = (await eventsResponse.json()) as { events?: EventRow[] };
      const turnsJson = (await turnsResponse.json()) as { turns?: TurnRow[] };
      if (eventsJson.events && eventsJson.events.length > 0) {
        setEvents((previous) => {
          const known = new Set(previous.map((event) => event.id));
          const appended = eventsJson.events!.filter((event) => !known.has(event.id));
          return appended.length > 0 ? [...previous, ...appended] : previous;
        });
      }
      if (turnsJson.turns) setTurns(turnsJson.turns);
    } catch {
      // 拉取失败就等下一次广播
    } finally {
      setStreaming(false);
    }
  }, [events, sessionId]);

  useStreamEvent((event, data) => {
    if (event !== "session.updated" && event !== "turn.updated") return;
    if (data.session_id !== sessionId) return;
    void refresh();
  });

  const groups = useMemo(() => groupTimeline(events), [events]);
  const turnsByKey = useMemo(() => {
    const map = new Map<string, TurnRow>();
    for (const turn of turns) map.set(`${turn.run_seq}:${turn.turn_index}`, turn);
    return map;
  }, [turns]);

  const toggle = (key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <PanelShell embedded={embedded}>
      <div className="panel-head">
        <span>时间线</span>
        <span className="count">
          {events.length} 条事件 · {groups.length} 组
        </span>
        <span className="spacer" />
        <div className="demo-row">
          <span
            className={`chip ${liveText ? "on" : ""}`}
            onClick={() => setLiveText((value) => !value)}
            title="实时正文：开启时每 500 ms 刷新正在生成的正文快照，关闭后只显示「生成中…」直到落盘"
          >
            <span className="k">L</span>实时正文
          </span>
          <span
            className={`chip ${showThinking ? "on alt" : ""}`}
            onClick={() => setShowThinking((value) => !value)}
            title="思考块只在流式快照里可见"
          >
            <span className="k">T</span>思考
          </span>
          <span
            className={`chip ${showTools ? "on cyan" : ""}`}
            onClick={() => setShowTools((value) => !value)}
            title="显示或隐藏工具执行事件"
          >
            <span className="k">O</span>工具
          </span>
          <span className={`chip ${streaming ? "on amber" : ""}`} onClick={() => void refresh()} title="手动拉取增量">
            <span className="k">R</span>刷新
          </span>
        </div>
      </div>

      <div className="timeline">
        {groups.length === 0 ? (
          <div className="empty">
            这个会话还没有事件。探针把 <code>index.ts</code> 加载进 Pi 后，下一次请求就会有数据。
          </div>
        ) : null}

        {groups.map((group, index) => {
          const last = index === groups.length - 1;
          if (group.turnIndex === null) return renderSessionBox(group, collapsed, toggle, showTools, sessionId);
          return renderTurnBox({
            group,
            turn: turnsByKey.get(group.key),
            isLast: last,
            collapsed: collapsed.has(group.key),
            onToggle: () => toggle(group.key),
            liveText,
            showThinking,
            showTools,
            sessionId,
          });
        })}
      </div>
    </PanelShell>
  );
}

function PanelShell({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  if (embedded) return <>{children}</>;
  return <div className="panel">{children}</div>;
}

function renderSessionBox(
  group: TimelineGroup,
  collapsed: Set<string>,
  toggle: (key: string) => void,
  showTools: boolean,
  sessionId: string,
) {
  const isCollapsed = collapsed.has("session");
  return (
    <div className={`turn-box ${isCollapsed ? "closed" : ""}`} key="session">
      <div className="turn-head" onClick={() => toggle("session")}>
        <span className="twist">{isCollapsed ? "▸" : "▾"}</span>
        <span className="idx">会话级事件</span>
        <span className="sum">不归属任何 Turn 的生命周期事件</span>
        <span className="spacer" />
        <span className="faint">{group.events.length} 条</span>
      </div>
      <div className="turn-body">
        {group.events.map((event) => (
          <EventLine key={event.id} event={event} showTools={showTools} sessionId={sessionId} />
        ))}
      </div>
    </div>
  );
}

function renderTurnBox(input: {
  group: TimelineGroup;
  turn: TurnRow | undefined;
  isLast: boolean;
  collapsed: boolean;
  onToggle: () => void;
  liveText: boolean;
  showThinking: boolean;
  showTools: boolean;
  sessionId: string;
}) {
  const { group, turn, isLast, collapsed, onToggle, liveText, showThinking, showTools, sessionId } = input;
  const summary = summarizeTurn(group, turn);
  const running = isRunning(group, isLast);
  const progress = running ? latestProgress(group) : null;

  return (
    <div
      className={`turn-box ${running ? "running" : ""} ${summary.toolErrors > 0 ? "failed" : ""} ${collapsed ? "closed" : ""}`}
      key={group.key}
    >
      <div className="turn-head" onClick={onToggle}>
        <span className="twist">{collapsed ? "▸" : "▾"}</span>
        <span className="idx">Turn {group.turnIndex}</span>
        <span className="sum">
          运行 {group.runSeq} · 工具 {summary.toolCount} 次
          {summary.toolDurationMs > 0 ? ` · ${formatDuration(summary.toolDurationMs)}` : ""}
        </span>
        <span className="spacer" />
        {running ? (
          <span className="badge ok">进行中</span>
        ) : summary.toolErrors > 0 ? (
          <span className="badge err">工具出错</span>
        ) : (
          <span className="badge">已完成</span>
        )}
        {progress ? <span className="snap">快照 {progress.updateCount} · 500ms 节流</span> : null}
        <span className="faint">
          ↑ {formatTokens(summary.tokensIn)} ↓ {formatTokens(summary.tokensOut)} ·{" "}
          <span style={{ color: "var(--cyan)" }}>
            R {formatTokens(summary.cacheRead)} W {formatTokens(summary.cacheWrite)}
          </span>{" "}
          · ${formatCost(summary.cost)}
        </span>
      </div>
      <div className="turn-body">
        {group.events.map((event) => {
          if (event.event_type === "message_progress") {
            return renderProgress(event, { running, liveText });
          }
          if (event.event_type === "turn_end") {
            const payload = (event.payload ?? {}) as { text?: unknown; thinking?: unknown };
            const text = typeof payload.text === "string" ? payload.text : "";
            const thinking = typeof payload.thinking === "string" ? payload.thinking : "";
            return (
              <div key={event.id}>
                <EventLine event={event} showTools={showTools} sessionId={sessionId} />
                {thinking !== "" && showThinking ? (
                  <div className="ev depth-1 thinking">
                    <span className="time" />
                    <span className="etype message">thinking</span>
                    <span className="body">
                      {thinking}
                      <span className="note"> · 由 message_update 合并</span>
                    </span>
                  </div>
                ) : null}
                {text !== "" ? (
                  <pre className="pre" style={{ marginLeft: 24 }}>
                    {text}
                  </pre>
                ) : (
                  <div className="ev depth-1">
                    <span className="time" />
                    <span className="etype message">正文</span>
                    <span className="body faint">本 Turn 没有正文输出（工具调用为主）</span>
                  </div>
                )}
              </div>
            );
          }
          return <EventLine key={event.id} event={event} showTools={showTools} sessionId={sessionId} />;
        })}
      </div>
    </div>
  );
}

/**
 * 进度快照行。
 * 正在跑的 Turn 用「打字机」样式展示半透明正文；已经结束的 Turn 只留一条降级说明——
 * 否则一个已完成的 Turn 里会一直挂着「生成中」，那是误导。
 */
function renderProgress(event: EventRow, options: { running: boolean; liveText: boolean }) {
  const payload = (event.payload ?? {}) as { text?: unknown; update_count?: unknown };
  const text = typeof payload.text === "string" ? payload.text : "";
  const updateCount = typeof payload.update_count === "number" ? payload.update_count : 0;

  if (!options.running) {
    return (
      <div className="ev depth-1" key={event.id}>
        <span className="time">{clockTime(event.occurred_at)}</span>
        <span className="etype message">流式快照</span>
        <span className="body faint">
          合并了 {updateCount} 次 message_update，已被 turn_end 的最终正文替代
          {text === "" ? "（快照里没有正文，可能是工具调用型 Turn）" : ""}
        </span>
      </div>
    );
  }

  if (!options.liveText) {
    return (
      <div className="ev depth-1" key={event.id}>
        <span className="time">{clockTime(event.occurred_at)}</span>
        <span className="etype message">生成中</span>
        <span className="body faint">
          实时正文已关闭（开关在上面），正文会在 turn_end 落盘后显示；流式快照仍在后台合并
        </span>
      </div>
    );
  }

  return (
    <div className="ev depth-1 streaming" key={event.id}>
      <span className="time">{clockTime(event.occurred_at)}</span>
      <span className="etype message">assistant</span>
      <span className="body">
        <span className="stream-text">{text === "" ? "（等待首个 token）" : text}</span>
        <span className="caret" />
        <div className="faint" style={{ fontSize: 10.5, marginTop: 4 }}>
          半透明区域为正在生成的正文，按 500 ms 快照刷新（已合并 {updateCount} 次更新）；
          这是流式重建，不是厂商返回的原始字节。
        </div>
      </span>
    </div>
  );
}

function EventLine({ event, showTools, sessionId }: { event: EventRow; showTools: boolean; sessionId: string }) {
  const description = describeEvent(event);
  const isTool = event.layer === "tool";
  if (isTool && !showTools) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const requestSeq =
    (event.event_type === "provider_request" || event.event_type === "provider_response") && typeof payload.requestSeq === "number"
      ? payload.requestSeq
      : null;

  return (
    <div className={`ev ${isTool ? "tool" : ""}`}>
      <span className="time">{clockTime(event.occurred_at)}</span>
      <span className={`etype ${LAYER_CLASS[event.layer] ?? "session"}`} title={event.event_type}>
        {event.event_type}
      </span>
      <span className="body">
        {description.text}
        {description.note ? <span className="note"> · {description.note}</span> : null}
        {requestSeq === null ? null : (
          <>
            {" "}
            <Link className="note" href={`/sessions/${encodeURIComponent(sessionId)}/requests/${requestSeq}`}>
              查看请求 #{requestSeq}
            </Link>
          </>
        )}
        {event.event_id.startsWith("progress:") ? null : (
          <span className="note"> · {shortId(event.event_id, 8)}</span>
        )}
      </span>
    </div>
  );
}
