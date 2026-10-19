import assert from "node:assert/strict";
import test from "node:test";

import { MergeTable, assistantLike, extractParts } from "../ext/merge.ts";
import { BoundedQueue } from "../ext/queue.ts";

const sizeOf = (item: string): number => Buffer.byteLength(item, "utf8");

test("有界队列：条数上限触发丢最旧并累加计数", () => {
  const queue = new BoundedQueue<string>(sizeOf, { maxRecords: 3, maxBytes: 1024 });
  for (const item of ["a", "b", "c", "d", "e"]) queue.push(item);

  assert.equal(queue.depth, 3);
  assert.equal(queue.droppedCount, 2);
  assert.deepEqual(queue.take(10), ["c", "d", "e"]);
});

test("有界队列：字节上限先于条数上限生效", () => {
  const queue = new BoundedQueue<string>(sizeOf, { maxRecords: 100, maxBytes: 10 });
  for (const item of ["1234", "5678", "90"]) queue.push(item);

  assert.equal(queue.bytes, 10);
  assert.equal(queue.depth, 3);
  assert.equal(queue.droppedCount, 0);

  // 一条 10 字节的记录进来后只剩它装得下，前三条被丢
  queue.push("abcdefghij");
  assert.equal(queue.bytes, 10);
  assert.equal(queue.depth, 1);
  assert.equal(queue.droppedCount, 3);
  assert.deepEqual(queue.take(10), ["abcdefghij"]);
});

test("有界队列：失败批次按原顺序放回队首", () => {
  const queue = new BoundedQueue<string>(sizeOf, { maxRecords: 10, maxBytes: 1024 });
  queue.push("1");
  queue.push("2");
  queue.push("3");

  const batch = queue.take(2);
  assert.deepEqual(batch, ["1", "2"]);
  queue.requeue(batch);

  assert.deepEqual(queue.take(10), ["1", "2", "3"]);
});

test("有界队列：takeWithin 按字节装车，单条超预算也会带走", () => {
  const queue = new BoundedQueue<string>(sizeOf, { maxRecords: 100, maxBytes: 10_000 });
  for (const item of ["aaaa", "bbbb", "cccc", "dddd"]) queue.push(item);

  const batch = queue.takeWithin(10, 8);
  assert.deepEqual(batch, ["aaaa", "bbbb"]);
  assert.equal(queue.depth, 2);

  const rest = queue.takeWithin(10, 1);
  assert.deepEqual(rest, ["cccc"]);
});

test("合并表：message_update 覆盖快照并计数，turn_end 出队", () => {
  const table = new MergeTable();
  const content = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

  table.noteMessage("s1", 1, 0, content("你好"), "2026-10-19T10:00:00.000Z");
  const snapshot = table.noteMessage("s1", 1, 0, content("你好，世界"), "2026-10-19T10:00:00.500Z");

  assert.equal(snapshot.updateCount, 2);
  assert.equal(snapshot.text, "你好，世界");
  assert.equal(snapshot.startedAt, "2026-10-19T10:00:00.000Z");

  const drained = table.drainProgress();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].text, "你好，世界");
  assert.equal(drained[0].update_count, 2);
  assert.equal(table.messageCount, 1); // drain 不删除，等 turn_end

  const consumed = table.consumeMessage(1, 0);
  assert.equal(consumed?.text, "你好，世界");
  assert.equal(table.messageCount, 0);
  assert.equal(table.consumeMessage(1, 0), undefined);
});

test("合并表：不同运行的同号 Turn 互不覆盖", () => {
  const table = new MergeTable();
  const content = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

  table.noteMessage("s1", 1, 0, content("第一次运行"), "2026-10-19T10:00:00.000Z");
  table.noteMessage("s1", 2, 0, content("第二次运行"), "2026-10-19T10:01:00.000Z");

  assert.equal(table.messageCount, 2);
  assert.equal(table.consumeMessage(1, 0)?.text, "第一次运行");
  assert.equal(table.consumeMessage(2, 0)?.text, "第二次运行");
});

test("合并表：工具部分结果按 toolCallId 合并，出队时带 updateCount", () => {
  const table = new MergeTable();
  table.noteToolPartial("tc_1", "s1", "bash", { chunk: "a" }, "2026-10-19T10:00:00.000Z");
  table.noteToolPartial("tc_1", "s1", "bash", { chunk: "ab" }, "2026-10-19T10:00:00.400Z");

  const records = table.drainToolPartials();
  assert.equal(records.length, 1);
  assert.equal(records[0].tool_call_id, "tc_1");
  assert.deepEqual(records[0].partial_result, { chunk: "ab" });
  assert.equal(table.toolCount, 1);

  const consumed = table.consumeTool("tc_1");
  assert.equal(consumed?.updateCount, 2);
  assert.equal(table.toolCount, 0);
});

test("assistantLike / extractParts：只认助手消息，正文与思考分开", () => {
  assert.equal(assistantLike({ role: "user", content: "hi" }), null);
  assert.equal(assistantLike(null), null);

  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先看文件" },
      { type: "text", text: "结论是 A" },
      { type: "toolCall", id: "tc_1", name: "read" },
    ],
  };
  assert.ok(assistantLike(message));
  const parts = extractParts((assistantLike(message) as { content: unknown }).content);
  assert.equal(parts.text, "结论是 A");
  assert.equal(parts.thinking, "先看文件");
  assert.equal(parts.toolCalls, 1);
});
