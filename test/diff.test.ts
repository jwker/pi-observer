import assert from "node:assert/strict";
import test from "node:test";

import { buildRows, diffLines, jsonLines, toBlocks } from "../src/lib/diff.ts";

test("差异：一行改一行", () => {
  const ops = diffLines(["x", "y", "z"], ["x", "Y", "z"]);
  assert.deepEqual(
    ops.map((op) => op.type),
    ["same", "removed", "added", "same"],
  );
});

test("差异：新增一行", () => {
  const ops = diffLines(["a"], ["a", "b"]);
  assert.deepEqual(
    ops.map((op) => op.type),
    ["same", "added"],
  );
});

test("差异：相同的开头与结尾被掐掉，中间整块比较", () => {
  const a = ["1", "2", "3", "4", "5"];
  const b = ["1", "2", "X", "4", "5"];
  const ops = diffLines(a, b);
  assert.equal(ops.filter((op) => op.type === "same").length, 4);
  assert.equal(ops.filter((op) => op.type === "removed").length, 1);
  assert.equal(ops.filter((op) => op.type === "added").length, 1);
});

test("行号：新增行只有新行号，删除行只有旧行号", () => {
  const rows = buildRows(diffLines(["a"], ["a", "b"]));
  assert.deepEqual(rows[0], { type: "same", text: "a", oldLine: 1, newLine: 1 });
  assert.deepEqual(rows[1], { type: "added", text: "b", oldLine: null, newLine: 2 });
});

test("折叠：变化行前后保留三行，其余合并成一段省略", () => {
  const a = Array.from({ length: 40 }, (_, i) => `line${i}`);
  const b = [...a];
  b[20] = "CHANGED";
  const blocks = toBlocks(buildRows(diffLines(a, b)), 3);
  assert.equal(blocks.length, 3, "省略段 + 差异段 + 省略段");
  assert.equal(blocks[0].kind, "gap");
  assert.equal(blocks[1].kind, "rows");
  assert.equal(blocks[2].kind, "gap");
  const rows = blocks[1].kind === "rows" ? blocks[1].rows : [];
  assert.equal(rows.length, 8, "变化行 + 前后各三行");
});

test("折叠：完全没变化时整段都是省略", () => {
  const a = ["a", "b"];
  const blocks = toBlocks(buildRows(diffLines(a, a)), 3);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "gap");
});

test("JSON 拆行：缩进两格", () => {
  assert.deepEqual(jsonLines({ a: 1 }), ['{', '  "a": 1', '}']);
});
