import assert from "node:assert/strict";
import test from "node:test";

import { buildMessageTree, type TreeNode } from "../src/main/lib/tree.ts";
import type { MessageIndexRow } from "../src/shared/types.ts";

function row(partial: Partial<MessageIndexRow> & { entry_id: string; entry_index: number }): MessageIndexRow {
  return {
    parent_id: null,
    kind: "message",
    role: "user",
    timestamp: null,
    summary: null,
    payload_bytes: 0,
    ...partial,
  };
}

function nodeOf(rows: MessageIndexRow[], entryId: string): TreeNode {
  const node = buildMessageTree(rows).byId.get(entryId);
  assert.ok(node, `树里应该有节点 ${entryId}`);
  return node;
}

// root → A → B（一条直链，每条的父是前一条）
const CHAIN: MessageIndexRow[] = [
  row({ entry_id: "root", entry_index: 1, kind: "model_change", role: null, summary: "模型 → x" }),
  row({ entry_id: "A", entry_index: 2, parent_id: "root", role: "user", summary: "读 PRD" }),
  row({ entry_id: "B", entry_index: 3, parent_id: "A", role: "assistant", summary: "读了" }),
];

test("直链：一个根、深度递增、全部在当前分支", () => {
  const tree = buildMessageTree(CHAIN);

  assert.equal(tree.total, 3);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]?.entry_id, "root");
  assert.equal(tree.forkPoints, 0);
  assert.equal(tree.orphans, 0);
  assert.equal(tree.currentLeafId, "B");
  assert.deepEqual([...tree.currentBranch].sort(), ["A", "B", "root"]);

  assert.equal(nodeOf(CHAIN, "root").depth, 0);
  assert.equal(nodeOf(CHAIN, "A").depth, 1);
  assert.equal(nodeOf(CHAIN, "B").depth, 2);

  for (const id of ["root", "A", "B"]) {
    const node = nodeOf(CHAIN, id);
    assert.equal(node.onCurrentBranch, true, `${id} 应在当前分支上`);
    assert.equal(node.branchStart, false, `${id} 不该被标成旁支`);
  }
});

test("分叉：当前分支之外的孩子标旁支，分叉点被数出来", () => {
  // root → A → B(3) 与 C(4)，最后一条是 C，所以当前分支走 C
  const rows = [...CHAIN, row({ entry_id: "C", entry_index: 4, parent_id: "A", role: "assistant", summary: "另一种答法" })];
  const tree = buildMessageTree(rows);

  assert.equal(tree.forkPoints, 1);
  assert.equal(nodeOf(rows, "A").forkPoint, true);
  assert.equal(nodeOf(rows, "root").forkPoint, false);
  assert.equal(tree.currentLeafId, "C");
  assert.deepEqual([...tree.currentBranch].sort(), ["A", "C", "root"]);

  const branch = nodeOf(rows, "B");
  assert.equal(branch.onCurrentBranch, false);
  assert.equal(branch.branchStart, true, "旁支的第一条要能标出来");
  assert.equal(branch.children.length, 0);

  const onBranch = nodeOf(rows, "C");
  assert.equal(onBranch.onCurrentBranch, true);
  assert.equal(onBranch.branchStart, false);
});

test("分叉：旁支后来长了尾巴，当前分支还是跟最后一条走", () => {
  // root → A → { B(3) → D(5), C(4) }：最后一条是 D
  const rows = [
    ...CHAIN,
    row({ entry_id: "C", entry_index: 4, parent_id: "A", role: "assistant", summary: "旧答法" }),
    row({ entry_id: "D", entry_index: 5, parent_id: "B", role: "toolResult", summary: "read PRD" }),
  ];
  const tree = buildMessageTree(rows);

  assert.equal(tree.currentLeafId, "D");
  assert.deepEqual([...tree.currentBranch].sort(), ["A", "B", "D", "root"]);
  assert.equal(nodeOf(rows, "C").branchStart, true, "C 是分叉出去的独立分支");
  assert.equal(nodeOf(rows, "C").onCurrentBranch, false);
  assert.equal(nodeOf(rows, "B").branchStart, false, "B 在当前分支上，不该被标成旁支");
  assert.equal(nodeOf(rows, "D").depth, 3);
});

test("父条目不在索引里：当成根并如实标记，不假装它没有父", () => {
  const rows = [
    row({ entry_id: "root", entry_index: 1 }),
    row({ entry_id: "x", entry_index: 2, parent_id: "没入库的父" }),
    row({ entry_id: "y", entry_index: 3, parent_id: "x" }),
  ];
  const tree = buildMessageTree(rows);

  assert.equal(tree.orphans, 1);
  assert.equal(tree.roots.length, 2);
  const orphan = nodeOf(rows, "x");
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.parent, null);
  assert.equal(orphan.branchStart, false, "x 是最后一条的父辈，仍在当前分支上；父不在索引里由 orphan 说明");
  // 子节点仍然连得上（y 的父是 x，x 在索引里）
  assert.equal(nodeOf(rows, "y").parent?.entry_id, "x");
  assert.equal(nodeOf(rows, "y").orphan, false);
});

test("父条目行号更后（文件被改过）：不连边，标成孤儿而不是编出环", () => {
  const rows = [
    row({ entry_id: "late", entry_index: 9 }),
    row({ entry_id: "early", entry_index: 1, parent_id: "late" }),
  ];
  const tree = buildMessageTree(rows);

  assert.equal(nodeOf(rows, "early").orphan, true);
  assert.equal(nodeOf(rows, "early").parent, null);
  assert.equal(tree.roots.length, 2);
});

test("输入乱序：一律按行号排，父先于子", () => {
  const rows = [
    row({ entry_id: "B", entry_index: 3, parent_id: "A" }),
    row({ entry_id: "A", entry_index: 2, parent_id: "root" }),
    row({ entry_id: "root", entry_index: 1 }),
  ];
  const tree = buildMessageTree(rows);

  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]?.entry_id, "root");
  assert.deepEqual(tree.roots[0]?.children.map((child) => child.entry_id), ["A"]);
  assert.equal(tree.currentLeafId, "B");
});

test("空输入：没有根、没有当前分支，不报错", () => {
  const tree = buildMessageTree([]);
  assert.equal(tree.total, 0);
  assert.equal(tree.roots.length, 0);
  assert.equal(tree.currentLeafId, null);
  assert.equal(tree.currentBranch.size, 0);
});
