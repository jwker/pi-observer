/**
 * 时间线分组（纯函数）。
 *
 * 分组键是 `run_seq + turn_index`：`turnIndex` 每次 `agent_start` 归零，
 * 单靠它会把不同运行的同号 Turn 合并到一起，所以必须带上运行序号（PRD §7.3 / D4）。
 * 没有 Turn 归属的事件（会话级、探针健康检查等）单独成组放在最后。
 */
import type { EventRow, TurnRow } from "./types.ts";

export type { EventRow, TurnRow };

export interface TimelineGroup {
  key: string;
  runSeq: number | null;
  turnIndex: number | null;
  events: EventRow[];
}

export function groupTimeline(events: EventRow[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();
  const loose: EventRow[] = [];

  for (const event of events) {
    if (event.run_seq === null || event.turn_index === null) {
      loose.push(event);
      continue;
    }
    const key = `${event.run_seq}:${event.turn_index}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, runSeq: event.run_seq, turnIndex: event.turn_index, events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }

  const ordered = [...groups.values()].sort((a, b) => {
    const runDiff = (a.runSeq ?? 0) - (b.runSeq ?? 0);
    if (runDiff !== 0) return runDiff;
    return (a.turnIndex ?? 0) - (b.turnIndex ?? 0);
  });

  if (loose.length > 0) {
    ordered.push({ key: "session", runSeq: null, turnIndex: null, events: loose });
  }
  return ordered;
}

export interface TurnSummary {
  toolCount: number;
  toolErrors: number;
  toolDurationMs: number;
  stopReason: string | null;
  updateCount: number;
  hasText: boolean;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** 从事件 + turns 行里汇总出一个 Turn 头部要显示的信息 */
export function summarizeTurn(group: TimelineGroup, turn?: TurnRow): TurnSummary {
  const summary: TurnSummary = {
    toolCount: 0,
    toolErrors: 0,
    toolDurationMs: 0,
    stopReason: null,
    updateCount: 0,
    hasText: false,
    tokensIn: turn?.tokens_in ?? null,
    tokensOut: turn?.tokens_out ?? null,
    cost: turn?.cost ?? null,
    startedAt: turn?.started_at ?? null,
    endedAt: turn?.ended_at ?? null,
  };

  for (const event of group.events) {
    if (event.event_type === "tool_execution_start") summary.toolCount += 1;
    if (event.event_type === "tool_execution_end") {
      const payload = event.payload as { isError?: unknown; durationMs?: unknown } | null;
      if (payload?.isError === true) summary.toolErrors += 1;
      if (typeof payload?.durationMs === "number") summary.toolDurationMs += payload.durationMs;
    }
    if (event.event_type === "turn_end") {
      const payload = event.payload as { stopReason?: unknown; updateCount?: unknown; text?: unknown } | null;
      if (typeof payload?.stopReason === "string") summary.stopReason = payload.stopReason;
      if (typeof payload?.updateCount === "number") summary.updateCount = payload.updateCount;
      if (typeof payload?.text === "string" && payload.text !== "") summary.hasText = true;
    }
    if (event.event_type === "turn_start" && !summary.startedAt) summary.startedAt = event.occurred_at;
  }

  return summary;
}

/** 该 Turn 是否还在进行中（有 turn_start，没有 turn_end，且是最新的一组） */
export function isRunning(group: TimelineGroup, isLast: boolean): boolean {
  if (!isLast) return false;
  const hasStart = group.events.some((event) => event.event_type === "turn_start");
  const hasEnd = group.events.some((event) => event.event_type === "turn_end");
  return hasStart && !hasEnd;
}

/** 进度快照（message_progress）取最后一条，用于「生成中」的半透明正文 */
export function latestProgress(group: TimelineGroup): { text: string; updateCount: number } | null {
  for (let i = group.events.length - 1; i >= 0; i -= 1) {
    const event = group.events[i];
    if (event.event_type !== "message_progress") continue;
    const payload = event.payload as { text?: unknown; update_count?: unknown } | null;
    return {
      text: typeof payload?.text === "string" ? payload.text : "",
      updateCount: typeof payload?.update_count === "number" ? payload.update_count : 0,
    };
  }
  return null;
}
