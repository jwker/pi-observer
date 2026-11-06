/**
 * 时间线行模型：Turn 分组、请求标识挂在助手行上。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionStream, turnWindow } from "../src/main/lib/stream.ts";
import type { RequestRef, TimelineEntry } from "../src/shared/types.ts";

function entry(partial: Partial<TimelineEntry> & { entry_id: string }): TimelineEntry {
  return {
    parent_id: null,
    kind: "message",
    role: "user",
    timestamp: null,
    entry_index: 0,
    text: null,
    thinking: null,
    tool_names: [],
    tool_call_id: null,
    tool_name: null,
    is_error: false,
    duration_ms: null,
    usage: null,
    provider: null,
    model: null,
    api: null,
    stop_reason: null,
    thinking_level: null,
    response_id: null,
    payload_bytes: 0,
    ...partial,
  };
}

function view(entries: TimelineEntry[]): {
  entries: TimelineEntry[];
  requests: Record<string, RequestRef>;
} {
  return {
    entries,
    requests: {},
  };
}

test("按用户消息切 Turn，第一条用户消息之前归「会话前」", () => {
  const data = view([
    entry({ entry_id: "m1", kind: "model_change", entry_index: 0 }),
    entry({ entry_id: "u1", entry_index: 1, text: "第一个问题", timestamp: "2026-11-02T11:40:30.000Z" }),
    entry({ entry_id: "a1", role: "assistant", entry_index: 2, text: "回答", timestamp: "2026-11-02T11:40:53.000Z" }),
    entry({ entry_id: "u2", entry_index: 3, text: "第二个问题", timestamp: "2026-11-02T11:41:30.000Z" }),
    entry({ entry_id: "a2", role: "assistant", entry_index: 4, text: "再答", timestamp: "2026-11-02T11:41:53.000Z" }),
  ]);
  const stream = buildSessionStream(data);
  assert.equal(stream.turns.length, 2);
  assert.equal(stream.turns[0]?.summary, "第一个问题");
  assert.equal(stream.turns[1]?.summary, "第二个问题");
  assert.equal(stream.prelude?.rows.length, 1);
  assert.equal(stream.prelude?.rows[0]?.category, "model");
});

test("助手行带上对应的请求标识", () => {
  const data = view([
    entry({ entry_id: "u1", entry_index: 1, text: "问题" }),
    entry({ entry_id: "a1", role: "assistant", entry_index: 2, text: "回答" }),
  ]);
  data.requests = {
    a1: {
      id: "req-000007-20261102T114049412Z",
      filename: "req-000007-20261102T114049412Z.json",
      path: "/store/sess-1/req-000007-20261102T114049412Z.json",
      seq: 7,
      written_at: "2026-11-02T11:40:49.412Z",
      size_bytes: 1234,
    },
  };
  const stream = buildSessionStream(data);
  const assistantRow = stream.turns[0]?.rows.find((row) => row.entryId === "a1");
  assert.equal(assistantRow?.requestId, "req-000007-20261102T114049412Z");
  assert.equal(assistantRow?.requestBytes, 1234);
});

test("Turn 统计工具数与 token", () => {
  const data = view([
    entry({ entry_id: "u1", entry_index: 1, text: "问题" }),
    entry({
      entry_id: "a1",
      role: "assistant",
      entry_index: 2,
      tool_names: ["read", "bash"],
      usage: { input: 100, output: 20, cache_read: 5, cache_write: 1, cost: 0.5 },
    }),
    entry({
      entry_id: "t1",
      role: "toolResult",
      entry_index: 3,
      tool_name: "read",
      tool_call_id: "call-1",
      is_error: true,
    }),
  ]);
  const stream = buildSessionStream(data);
  const turn = stream.turns[0];
  assert.equal(turn?.stats.toolCount, 1);
  assert.equal(turn?.stats.toolErrors, 1);
  assert.equal(turn?.stats.tokensIn, 100);
  assert.equal(turn?.stats.tokensOut, 20);
  assert.equal(turn?.stats.cost, 0.5);
});

test("分页按 Turn 算，加载到最早时才给 prelude", () => {
  const entries: TimelineEntry[] = [];
  for (let i = 0; i < 25; i += 1) {
    entries.push(entry({ entry_id: `u${i}`, entry_index: i * 2, text: `问题 ${i}` }));
    entries.push(entry({ entry_id: `a${i}`, role: "assistant", entry_index: i * 2 + 1 }));
  }
  const stream = buildSessionStream(view(entries));
  const first = turnWindow(stream, 1, 20);
  assert.equal(first.turns.length, 20);
  assert.equal(first.hasEarlier, true);
  assert.equal(first.prelude, null);

  const second = turnWindow(stream, 2, 20);
  assert.equal(second.turns.length, 25);
  assert.equal(second.hasEarlier, false);
});
