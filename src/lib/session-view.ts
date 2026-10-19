/**
 * 会话列表的纯逻辑（PRD §11.1）：状态口径、分组排序、筛选。
 *
 * 这些规则一旦写进组件就只能靠人眼看，所以单独成文件，直接跑 `node --test`。
 */
import type { SessionListItem, SessionRow } from "./types.ts";

/**
 * 显示用的状态。
 *
 * `unreconciled` 不是一个真实状态，而是「不知道」：从会话文件回填的会话，
 * `sessions.state` 是回填时写的默认值——文件里没有进程或 agent 的运行状态，
 * 说它「空闲」就是编的。只有收到过实时事件的会话（`live` / `merged`）才有真状态。
 */
export type DisplayState = "active" | "idle" | "ended" | "unreconciled";

export const STATE_META: Record<DisplayState, { label: string; className: string; dot: string }> = {
  active: { label: "进行中", className: "badge ok", dot: "var(--green)" },
  idle: { label: "空闲", className: "badge warn", dot: "var(--amber)" },
  ended: { label: "已结束", className: "badge", dot: "var(--fg-3)" },
  unreconciled: { label: "未对账", className: "badge plain", dot: "var(--fg-3)" },
};

export const SOURCE_LABELS: Record<string, string> = {
  live: "实时",
  backfill: "回填",
  merged: "已对账",
};

export const UNKNOWN_CWD = "（未知工作目录）";

export function displayState(session: Pick<SessionRow, "state" | "source">): DisplayState {
  if (session.source === "backfill") return "unreconciled";
  return session.state === "active" || session.state === "idle" || session.state === "ended" ? session.state : "ended";
}

export function countByState(items: SessionListItem[]): Record<DisplayState, number> {
  const counts: Record<DisplayState, number> = { active: 0, idle: 0, ended: 0, unreconciled: 0 };
  for (const item of items) counts[displayState(item)] += 1;
  return counts;
}

/** 排序键：最后活跃时间；没有就用开始时间；都没有返回空串（排在最后） */
export function activityKey(session: Pick<SessionRow, "last_activity_at" | "started_at">): string {
  return session.last_activity_at ?? session.started_at ?? "";
}

export interface SessionGroup {
  cwd: string;
  sessions: SessionListItem[];
  /** 组内最近一次活动，组与组之间也按它倒序 */
  lastActivity: string;
}

/**
 * 按项目分组：会话按活动时间倒序，分组按组内最近的活动倒序。
 * 同一时间的用会话 id 兜底，保证每次渲染顺序一致。
 */
export function groupByProject(items: SessionListItem[]): SessionGroup[] {
  const sorted = [...items].sort((a, b) => {
    const ka = activityKey(a);
    const kb = activityKey(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
  });

  const groups = new Map<string, SessionGroup>();
  for (const item of sorted) {
    const cwd = item.cwd || UNKNOWN_CWD;
    const existing = groups.get(cwd);
    if (existing) existing.sessions.push(item);
    else groups.set(cwd, { cwd, sessions: [item], lastActivity: activityKey(item) });
  }
  return [...groups.values()];
}

export interface SessionFilters {
  query?: string;
  /** "all" 或 DisplayState */
  state?: string;
  /** "all" 或 source（live / backfill / merged） */
  source?: string;
}

export function filterSessions(items: SessionListItem[], filters: SessionFilters = {}): SessionListItem[] {
  const needle = (filters.query ?? "").trim().toLowerCase();
  const state = filters.state ?? "all";
  const source = filters.source ?? "all";

  return items.filter((item) => {
    if (state !== "all" && displayState(item) !== state) return false;
    if (source !== "all" && item.source !== source) return false;
    if (needle === "") return true;
    const haystack =
      `${item.session_id} ${item.cwd} ${item.name ?? ""} ${item.first_user_text ?? ""} ${item.file_path ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/** 「今天 0 点」的 ISO 时间（服务器本地时区），用于和库里的 ISO 字符串直接比较 */
export function localDayStartIso(now: Date): string {
  const start = new Date(now.getTime());
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}
