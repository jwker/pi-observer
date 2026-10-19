import assert from "node:assert/strict";
import test from "node:test";

import {
  clipForDisplay,
  filterToolCalls,
  toolArgSummary,
  toolNameOptions,
  toolResultText,
  toolStatusMeta,
  toolTurnOptions,
} from "../src/lib/tool-view.ts";

const rows = [
  { tool_name: "read", turn_index: 1, is_error: 0 },
  { tool_name: "bash", turn_index: 1, is_error: 1 },
  { tool_name: "bash", turn_index: 2, is_error: 0 },
];

test("工具状态：成功 / 失败，带耗时说明", () => {
  assert.equal(toolStatusMeta(0, 186).label, "成功");
  assert.equal(toolStatusMeta(0, 186).className, "badge ok");
  assert.equal(toolStatusMeta(1, 6118).label, "失败");
  assert.equal(toolStatusMeta(1, 6118).className, "badge err");
  assert.match(toolStatusMeta(1, 6118).title, /6118 ms/);
});

test("参数摘要：能解析就压成一行，解析不了就原样截断", () => {
  assert.equal(toolArgSummary('{"command":"pnpm run dev","timeout":120000}'), '{ command: pnpm run dev, timeout: 120000 }');
  assert.equal(toolArgSummary(null), "（无参数）");
  const raw = toolArgSummary("x".repeat(300), 20);
  assert.equal(raw.length, 21);
  assert.ok(raw.endsWith("…"));
});

test("筛选：按名称、Turn、是否出错组合过滤", () => {
  assert.deepEqual(
    filterToolCalls(rows, { toolName: "all", turn: "all", errorsOnly: false }).map((row) => row.tool_name),
    ["read", "bash", "bash"],
  );
  assert.deepEqual(
    filterToolCalls(rows, { toolName: "bash", turn: "all", errorsOnly: false }).map((row) => row.turn_index),
    [1, 2],
  );
  assert.deepEqual(
    filterToolCalls(rows, { toolName: "all", turn: "1", errorsOnly: false }).map((row) => row.tool_name),
    ["read", "bash"],
  );
  assert.deepEqual(
    filterToolCalls(rows, { toolName: "all", turn: "all", errorsOnly: true }).map((row) => row.is_error),
    [1],
  );
  assert.deepEqual(
    filterToolCalls(rows, { toolName: "bash", turn: "2", errorsOnly: true }),
    [],
  );
});

test("选项：工具名去重排序，Turn 去重升序并只留最近 N 个", () => {
  assert.deepEqual(toolNameOptions(rows), ["bash", "read"]);
  assert.deepEqual(toolTurnOptions(rows), [1, 2]);
  assert.deepEqual(toolTurnOptions([{ turn_index: 9 }, { turn_index: 1 }, { turn_index: null }], 1), [9]);
});

test("工具结果：文本块、字符串、JSON、空值与图片说明", () => {
  const content = toolResultText({
    role: "toolResult",
    content: [
      { type: "text", text: "stdout\n" },
      { type: "text", text: "stderr\n" },
      { type: "image", data: "…" },
    ],
  });
  assert.equal(content.kind, "text");
  assert.equal(content.text, "stdout\nstderr\n");
  assert.match(content.note ?? "", /1 个 image 块/);

  assert.deepEqual(toolResultText("hello"), { kind: "text", text: "hello", note: null });
  assert.deepEqual(toolResultText(null), { kind: "empty", text: "", note: null });
  const json = toolResultText({ bytes: 8421 });
  assert.equal(json.kind, "json");
  assert.match(json.text, /"bytes": 8421/);

  const onlyImage = toolResultText({ content: [{ type: "image" }] });
  assert.equal(onlyImage.kind, "json");
  assert.equal(onlyImage.text, "");
  assert.match(onlyImage.note ?? "", /image/);
});

test("展示截断：短内容原样，长内容只给前段并说明", () => {
  const args = clipForDisplay({ command: "ls" }, 100);
  assert.equal(args.truncated, false);
  assert.match(args.text, /"command": "ls"/);

  const long = clipForDisplay({ text: "x".repeat(500) }, 50);
  assert.equal(long.truncated, true);
  assert.match(long.text, /只显示前 50 个字符/);
});
