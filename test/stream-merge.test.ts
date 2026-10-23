import assert from "node:assert/strict";
import test from "node:test";

import { mergeStreamData, normalizeStreamData } from "../src/lib/stream-merge.ts";
import type { SessionStreamData } from "../src/lib/types.ts";

function empty(): SessionStreamData {
  return {
    session: { session_id: "s1", cwd: "/tmp/p" } as SessionStreamData["session"],
    messages: [],
    turns: [],
    events: [],
    tools: [],
    requests: [],
    totals: { messages: 0, turns: 0, events: 0, tools: 0, requests: 0 },
  };
}

test("合并：新的覆盖旧的，旧的留下", () => {
  const previous = empty();
  previous.messages = [
    { entry_id: "m1", entry_index: 1, text: "旧" } as SessionStreamData["messages"][number],
  ];
  previous.events = [
    { id: 1, event_id: "e1" } as SessionStreamData["events"][number],
  ];

  const next = empty();
  next.messages = [
    { entry_id: "m1", entry_index: 1, text: "新" } as SessionStreamData["messages"][number],
    { entry_id: "m2", entry_index: 2, text: "新增" } as SessionStreamData["messages"][number],
  ];
  next.events = [{ id: 2, event_id: "e2" } as SessionStreamData["events"][number]];

  const merged = mergeStreamData(previous, next);
  assert.equal(merged.messages.length, 2, "旧的不丢，新的进来");
  assert.equal(merged.messages[0].text, "新", "同一条以新的为准");
  assert.equal(merged.messages[1].entry_id, "m2");
  assert.equal(merged.events.length, 2, "事件按 id 合并");
});

test("合并：按顺序排好", () => {
  const previous = empty();
  previous.messages = [
    { entry_id: "m3", entry_index: 3 } as SessionStreamData["messages"][number],
  ];
  const next = empty();
  next.messages = [
    { entry_id: "m1", entry_index: 1 } as SessionStreamData["messages"][number],
    { entry_id: "m2", entry_index: 2 } as SessionStreamData["messages"][number],
  ];
  const merged = mergeStreamData(previous, next);
  assert.deepEqual(
    merged.messages.map((m) => m.entry_index),
    [1, 2, 3],
    "消息按 entry_index 排",
  );
});

test("合并：条数取两边更大的那个", () => {
  const previous = empty();
  previous.totals = { messages: 100, turns: 5, events: 9, tools: 2, requests: 1 };
  const next = empty();
  next.totals = { messages: 120, turns: 3, events: 4, tools: 7, requests: 2 };

  const merged = mergeStreamData(previous, next);
  assert.equal(merged.totals.messages, 120);
  assert.equal(merged.totals.turns, 5, "旧会话的条数不能被新的小数字覆盖掉");
  assert.equal(merged.totals.tools, 7);
});

test("整理：全量数据按同一套顺序返回", () => {
  const data = empty();
  data.messages = [
    { entry_id: "b", entry_index: 2 } as SessionStreamData["messages"][number],
    { entry_id: "a", entry_index: 1 } as SessionStreamData["messages"][number],
  ];
  const normalized = normalizeStreamData(data);
  assert.deepEqual(
    normalized.messages.map((m) => m.entry_id),
    ["a", "b"],
  );
});
