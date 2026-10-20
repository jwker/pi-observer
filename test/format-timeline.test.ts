import assert from "node:assert/strict";
import test from "node:test";

import {
  clockTime,
  dateTime,
  formatBytes,
  formatCost,
  formatDuration,
  formatTokens,
  previewJson,
  relativeTime,
  shortId,
} from "../src/lib/format.ts";
import { groupTimeline, isRunning, latestProgress, summarizeTurn } from "../src/lib/timeline.ts";
import type { EventRow, TurnRow } from "../src/lib/types.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");

function event(partial: Partial<EventRow> & { id: number; event_type: string }): EventRow {
  return {
    event_id: `ev_${partial.id}`,
    session_id: "s1",
    layer: "turn",
    run_seq: null,
    turn_index: null,
    payload: null,
    occurred_at: "2026-10-19T10:00:00.000Z",
    received_at: "2026-10-19T10:00:00.000Z",
    ...partial,
  };
}

test("相对时间：秒 / 分钟 / 小时 / 昨天 / 月日", () => {
  assert.equal(relativeTime(new Date(NOW - 2_000).toISOString(), NOW), "刚刚");
  assert.equal(relativeTime(new Date(NOW - 30_000).toISOString(), NOW), "30 秒前");
  assert.equal(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW), "5 分钟前");
  assert.equal(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW), "3 小时前");
  assert.equal(relativeTime(null, NOW), "—");
  assert.equal(relativeTime("不是时间", NOW), "—");
});

test("时钟与完整时间格式", () => {
  const iso = "2026-10-19T10:00:05.000Z";
  assert.match(clockTime(iso), /^\d{2}:\d{2}:\d{2}$/);
  assert.match(dateTime(iso), /^2026-10-19 \d{2}:\d{2}:\d{2}$/);
  assert.equal(clockTime(null), "—");
});

test("数字格式：token / 成本 / 耗时 / 字节 / 短 ID", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(128_000), "128K");
  assert.equal(formatTokens(1_240_000), "1.2M");
  assert.equal(formatTokens(null), "—");
  assert.equal(formatCost(0.014), "0.01");
  assert.equal(formatDuration(186), "186 ms");
  assert.equal(formatDuration(6100), "6.1 s");
  assert.equal(formatDuration(65_000), "1 分 5 秒");
  assert.equal(formatBytes(8421), "8.2 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
  assert.equal(shortId("01a149bf-df78", 8), "01a149bf");
  assert.equal(shortId("短", 8), "短");
});

test("previewJson：对象与数组浅展开并压成一行", () => {
  assert.equal(previewJson({ path: "a.md" }), "{ path: a.md }");
  assert.equal(previewJson(["a", "b"]), "[a, b]");
  assert.equal(previewJson(null), null);
  assert.equal(previewJson({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })?.includes("…"), true);
  assert.equal(previewJson("很长的文本".repeat(50))?.length, 141);
});

test("时间线分组：按运行序号 + Turn 分组，会话级事件放最后", () => {
  const groups = groupTimeline([
    event({ id: 1, event_type: "session_start" }),
    event({ id: 2, event_type: "turn_start", run_seq: 1, turn_index: 0 }),
    event({ id: 3, event_type: "tool_execution_start", run_seq: 1, turn_index: 0, layer: "tool" }),
    event({ id: 4, event_type: "turn_end", run_seq: 1, turn_index: 0 }),
    event({ id: 5, event_type: "turn_start", run_seq: 2, turn_index: 0 }),
    event({ id: 6, event_type: "turn_end", run_seq: 2, turn_index: 0 }),
  ]);

  assert.equal(groups.length, 3);
  assert.equal(groups[0].key, "1:0");
  assert.equal(groups[0].events.length, 3);
  assert.equal(groups[1].key, "2:0");
  assert.equal(groups[2].key, "session");
  assert.equal(groups[2].events.length, 1);
});

test("时间线分组：不同运行的同号 Turn 不会被合并", () => {
  const groups = groupTimeline([
    event({ id: 1, event_type: "turn_start", run_seq: 1, turn_index: 3 }),
    event({ id: 2, event_type: "turn_start", run_seq: 2, turn_index: 3 }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.key),
    ["1:3", "2:3"],
  );
});

test("Turn 汇总：工具次数、出错、耗时、stopReason、token", () => {
  const turn: TurnRow = {
    id: 1,
    session_id: "s1",
    run_seq: 1,
    turn_index: 0,
    message_entry_id: "msg_1",
    started_at: "2026-10-19T10:00:01.000Z",
    ended_at: "2026-10-19T10:00:06.000Z",
    stop_reason: "stop",
    thinking_level: "medium",
    tokens_in: 100,
    tokens_out: 20,
    cache_read: 30,
    cache_write: 40,
    cost: 0.01,
  };

  const groups = groupTimeline([
    event({ id: 1, event_type: "turn_start", run_seq: 1, turn_index: 0 }),
    event({ id: 2, event_type: "tool_execution_start", run_seq: 1, turn_index: 0, layer: "tool" }),
    event({
      id: 3,
      event_type: "tool_execution_end",
      run_seq: 1,
      turn_index: 0,
      layer: "tool",
      payload: { isError: true, durationMs: 6100 },
    }),
    event({
      id: 4,
      event_type: "turn_end",
      run_seq: 1,
      turn_index: 0,
      payload: { stopReason: "stop", updateCount: 42, text: "正文" },
    }),
  ]);

  const summary = summarizeTurn(groups[0], turn);
  assert.equal(summary.toolCount, 1);
  assert.equal(summary.toolErrors, 1);
  assert.equal(summary.toolDurationMs, 6100);
  assert.equal(summary.stopReason, "stop");
  assert.equal(summary.updateCount, 42);
  assert.equal(summary.hasText, true);
  assert.equal(summary.tokensIn, 100);
  assert.equal(summary.cacheRead, 30);
  assert.equal(summary.cacheWrite, 40);
  assert.equal(summary.cost, 0.01);
  assert.equal(summary.startedAt, "2026-10-19T10:00:01.000Z");
});

test("进行中判定与最新进度快照", () => {
  const running = groupTimeline([
    event({ id: 1, event_type: "turn_start", run_seq: 1, turn_index: 0 }),
    event({
      id: 2,
      event_type: "message_progress",
      run_seq: 1,
      turn_index: 0,
      layer: "message",
      payload: { text: "第二段", update_count: 25 },
    }),
  ]);

  assert.equal(isRunning(running[0], true), true);
  assert.equal(isRunning(running[0], false), false);
  assert.deepEqual(latestProgress(running[0]), { text: "第二段", updateCount: 25 });

  const finished = groupTimeline([
    event({ id: 1, event_type: "turn_start", run_seq: 1, turn_index: 0 }),
    event({ id: 2, event_type: "turn_end", run_seq: 1, turn_index: 0 }),
  ]);
  assert.equal(isRunning(finished[0], true), false);
  assert.equal(latestProgress(finished[0]), null);
});
