/**
 * 消息树（纯函数，PRD §11.2）。
 *
 * 输入是会话文件条目的「索引行」（不含 payload），输出父子结构 + 当前分支。
 * 三个约定：
 *
 *   1. 顺序一律按 `entry_index`（文件行号）排：同一秒的条目也能稳定排序。
 *   2. 只在「父条目行号更小」时才连边。追加写的文件必然满足这一点；不满足说明文件被改过
 *      或顺序异常，此时把该节点当成新的根并标 `orphan`，界面如实说「父条目不在索引里」，
 *      不假装它没有父、也不猜。这条规则同时保证结构里不可能出现环（父链行号严格递减）。
 *   3. 「当前分支」= 文件里最后一条条目（行号最大）到根的路径。Pi 的会话文件是追加写的，
 *      最后一条就是当前那条分支的叶；其余分支只标「非当前分支」，不说「已废弃」——
 *      我们没有依据判断它被废弃。
 */
import type { MessageIndexRow } from "../../shared/types.ts";

export interface TreeNode extends MessageIndexRow {
  /** 已连上的父节点；根为 null */
  parent: TreeNode | null;
  children: TreeNode[];
  /** 根为 0 */
  depth: number;
  /** 在「最后一条条目 → 根」这条路径上 */
  onCurrentBranch: boolean;
  /** 有多个孩子 */
  forkPoint: boolean;
  /** 分叉起点：自己不在当前分支、父节点却在。旁支的根（父为空）不算——那不是分叉出去的分支 */
  branchStart: boolean;
  /** `parent_id` 有值但连不上（条目不在索引里，或行号不满足「父更早」） */
  orphan: boolean;
}

export interface MessageTree {
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
  /** 当前分支的叶（文件里最后一条条目）；没有条目时为 null */
  currentLeafId: string | null;
  /** 当前分支上的条目 id */
  currentBranch: Set<string>;
  forkPoints: number;
  orphans: number;
  total: number;
}

export function buildMessageTree(entries: MessageIndexRow[]): MessageTree {
  const ordered = [...entries].sort((a, b) => a.entry_index - b.entry_index);

  const byId = new Map<string, TreeNode>();
  const nodes: TreeNode[] = [];
  for (const entry of ordered) {
    const node: TreeNode = {
      ...entry,
      parent: null,
      children: [],
      depth: 0,
      onCurrentBranch: false,
      forkPoint: false,
      branchStart: false,
      orphan: false,
    };
    nodes.push(node);
    // 同一份文件里 id 不会重复；真重复了保留先出现的那个，后一个按 orphan 处理
    if (!byId.has(entry.entry_id)) byId.set(entry.entry_id, node);
  }

  const roots: TreeNode[] = [];
  for (const node of nodes) {
    const parent = node.parent_id === null ? undefined : byId.get(node.parent_id);
    if (parent !== undefined && parent !== node && parent.entry_index < node.entry_index) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      node.orphan = node.parent_id !== null;
      roots.push(node);
    }
  }

  const setDepth = (node: TreeNode, depth: number) => {
    node.depth = depth;
    for (const child of node.children) setDepth(child, depth + 1);
  };
  for (const root of roots) setDepth(root, 0);

  // 当前分支：最后一条条目往上走到根（父链行号严格递减，一定会终止）
  const last = nodes.length > 0 ? nodes[nodes.length - 1] : null;
  const currentBranch = new Set<string>();
  for (let cursor = last; cursor !== null; cursor = cursor.parent) currentBranch.add(cursor.entry_id);

  for (const node of nodes) {
    node.onCurrentBranch = currentBranch.has(node.entry_id);
    node.forkPoint = node.children.length > 1;
    node.branchStart = !node.onCurrentBranch && node.parent !== null && node.parent.onCurrentBranch;
  }

  return {
    roots,
    byId,
    currentLeafId: last === null ? null : last.entry_id,
    currentBranch,
    forkPoints: nodes.filter((node) => node.forkPoint).length,
    orphans: nodes.filter((node) => node.orphan).length,
    total: nodes.length,
  };
}
