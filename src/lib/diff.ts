/**
 * 逐行差异：把两次请求的正文按行比较，标出增删。
 *
 * 和 `git diff` 同一套思路：
 *   1. 先掐掉两段相同的开头与结尾（连续对话里大部分内容没变，这一步能省掉大量计算）；
 *   2. 剩下的部分用 LCS 求最长公共子序列，得出增删行；
 *   3. 行数太多时退化成整块替换，避免一次比较拖垮服务。
 */

/** 一处差异。 */
export type DiffOp =
  | { type: "same"; old: string; new: string }
  | { type: "removed"; old: string }
  | { type: "added"; new: string };

/** 带行号的差异行。 */
export interface DiffRow {
  type: "same" | "added" | "removed";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** 差异块：连续的差异行，或一段被折叠掉的相同内容。 */
export type DiffBlock =
  | { kind: "rows"; rows: DiffRow[] }
  | { kind: "gap"; count: number };

/** LCS 表的规模上限；超过就整块替换 */
const MAX_LCS_CELLS = 4_000_000;

/** 比较两组行。 */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: DiffOp[] = [];

  for (let i = 0; i < start; i++) ops.push({ type: "same", old: a[i], new: b[i] });

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const line of midA) ops.push({ type: "removed", old: line });
    for (const line of midB) ops.push({ type: "added", new: line });
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = new Uint32Array((n + 1) * (m + 1));

    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: "same", old: midA[i], new: midB[j] });
        i++;
        j++;
      } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
        ops.push({ type: "removed", old: midA[i] });
        i++;
      } else {
        ops.push({ type: "added", new: midB[j] });
        j++;
      }
    }
    while (i < n) ops.push({ type: "removed", old: midA[i++] });
    while (j < m) ops.push({ type: "added", new: midB[j++] });
  }

  for (let k = 0; k < a.length - endA; k++) {
    ops.push({ type: "same", old: a[endA + k], new: b[endB + k] });
  }
  return ops;
}

/** 给差异行标上旧行号与新行号。 */
export function buildRows(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const op of ops) {
    if (op.type === "same") {
      oldNo++;
      newNo++;
      rows.push({ type: "same", text: op.old, oldLine: oldNo, newLine: newNo });
    } else if (op.type === "removed") {
      oldNo++;
      rows.push({ type: "removed", text: op.old, oldLine: oldNo, newLine: null });
    } else {
      newNo++;
      rows.push({ type: "added", text: op.new, oldLine: null, newLine: newNo });
    }
  }
  return rows;
}

/** 把差异行切块：变化行前后各留 context 行，其余合并成一段省略。 */
export function toBlocks(rows: DiffRow[], context = 3): DiffBlock[] {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.type === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(rows.length - 1, index + context); k++) {
      keep.add(k);
    }
  });

  const blocks: DiffBlock[] = [];
  let index = 0;
  while (index < rows.length) {
    if (keep.has(index)) {
      const start = index;
      while (index < rows.length && keep.has(index)) index++;
      blocks.push({ kind: "rows", rows: rows.slice(start, index) });
    } else {
      const start = index;
      while (index < rows.length && !keep.has(index)) index++;
      blocks.push({ kind: "gap", count: index - start });
    }
  }
  return blocks;
}

/** JSON 文本按缩进两格拆成行，供比较用。 */
export function jsonLines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n");
}
