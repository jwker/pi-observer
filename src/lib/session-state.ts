/**
 * 会话状态的自愈：文件没了就把状态改成「已结束」（PRD §9.3 / §11.1）。
 *
 * **为什么需要**：会话状态由探针上报。探针进程被强杀、网络断了、Pi 崩了——
 * 这些情况下 `agent_settled` 与 `session_shutdown` 都不会到达，会话就永远停在
 * `active`，界面上一直显示「进行中」。这不是事实，只是「最后已知的状态」。
 *
 * **怎么判断**：会话文件是真相源。文件不在了，会话就不可能还在进行。
 * 这不是猜测——Pi 正在写的会话一定有对应的 `.jsonl` 文件。
 *
 * **什么时候做**：启动扫描时做一次。理由：
 *   - 启动扫描已经在遍历会话目录，知道哪些文件还在，多一次比对很便宜；
 *   - 清理任务本来就在启动时跑（保留期），顺手一起做；
 *   - 不做成定时任务：状态错乱是低频事件，为它每秒扫一遍库不值得。
 */
import { existsSync } from "node:fs";

import type { Db } from "./db.ts";
import { log } from "./log.ts";

export interface StaleSessionOutcome {
  /** 被改成的会话 id */
  ended: string[];
  /** 库里处于 active 但文件已经不在的会话 id（不管有没有改成，都如实列出来） */
  vanished: string[];
}

/**
 * 把「文件已不存在」且仍标着 `active` 的会话推进到 `ended`。
 *
 * 只改 `active`：`idle` 与 `ended` 不用动；`idle` 是探针明确上报的，
 * 文件被临时移走（例如用户整理目录）不代表会话结束了。
 *
 * `file_path` 为空的会话不动：只有探针上报过、没进过文件的会话，我们无从判断。
 */
export function endSessionsWithoutFile(
  db: Db,
  options: { exists?: (path: string) => boolean; now?: () => string } = {},
): StaleSessionOutcome {
  const exists = options.exists ?? existsSync;
  const rows = db
    .prepare(
      `SELECT session_id, file_path FROM sessions
        WHERE state = 'active' AND file_path IS NOT NULL AND file_path <> ''`,
    )
    .all() as Array<{ session_id: string; file_path: string }>;

  const vanished: string[] = [];
  const ended: string[] = [];
  for (const row of rows) {
    if (exists(row.file_path)) continue;
    vanished.push(row.session_id);
    const result = db
      .prepare("UPDATE sessions SET state = 'ended' WHERE session_id = ? AND state = 'active'")
      .run(row.session_id);
    if (Number(result.changes) > 0) ended.push(row.session_id);
  }

  if (ended.length > 0) {
    log("info", "state", "会话文件已不存在，状态改为已结束", {
      count: ended.length,
      sessions: ended.slice(0, 10),
    });
  }

  return { ended, vanished };
}
