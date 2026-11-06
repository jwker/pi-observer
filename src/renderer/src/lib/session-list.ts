/**
 * 会话列表的分组与排序（纯逻辑，客户端组件用）。
 *
 * 会话没有「运行中 / 空闲」这种状态了：项目不连着 Pi 进程，
 * 不知道此刻有没有会话在跑。只按最后修改时间排。
 */
import type { SessionListItem } from "@shared/types.ts";

export const UNKNOWN_CWD = "（未知工作目录）";

export interface SessionGroup {
  cwd: string;
  sessions: SessionListItem[];
  /** 组内最近一次活动 */
  lastActivity: string;
}

/** 按项目分组：会话按最后修改时间倒序，分组按组内最近的活动倒序 */
export function groupByProject(items: SessionListItem[]): SessionGroup[] {
  const sorted = [...items].sort((a, b) => {
    const at = a.last_activity_at ?? "";
    const bt = b.last_activity_at ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.session_id < b.session_id ? 1 : a.session_id > b.session_id ? -1 : 0;
  });

  const groups = new Map<string, SessionGroup>();
  for (const item of sorted) {
    const cwd = item.cwd || UNKNOWN_CWD;
    const existing = groups.get(cwd);
    if (existing) {
      existing.sessions.push(item);
      if (item.last_activity_at !== null && item.last_activity_at > existing.lastActivity) {
        existing.lastActivity = item.last_activity_at;
      }
    } else {
      groups.set(cwd, { cwd, sessions: [item], lastActivity: item.last_activity_at ?? "" });
    }
  }
  return [...groups.values()];
}
