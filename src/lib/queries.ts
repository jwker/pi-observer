import { Db, getDb } from "./db.ts";
import { localDayStartIso } from "./session-view.ts";
import type {
  EventRow,
  MessageDetail,
  MessageIndexRow,
  OverviewStats,
  ProbeStatusRow,
  SessionListItem,
  SessionRow,
  ToolCallRow,
  TurnRow,
} from "./types.ts";

export type {
  EventRow,
  MessageDetail,
  MessageIndexRow,
  OverviewStats,
  ProbeStatusRow,
  SessionListItem,
  SessionRow,
  ToolCallRow,
  TurnRow,
} from "./types.ts";

/** 树标签只显示前这么多字符；更长的正文在点击节点时按需取（`getMessageDetail`） */
const SUMMARY_CHARS = 200;

/**
 * `node:sqlite` 返回的是 null 原型对象。React 把这类对象从服务端组件传给客户端组件时会直接
 * 抛「Only plain objects … null prototypes are not supported」并 500，而 `next build` 因为页面是
 * 动态渲染所以发现不了。所有查询结果出门前统一摊平成普通对象。
 */
function plain<T extends object>(row: T): T {
  return { ...row };
}

export function listSessions(db: Db = getDb(), limit = 200): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT session_id, cwd, file_path, parent_session, name, started_at, last_activity_at,
              message_count, turn_count, tool_call_count, tokens_in, tokens_out, cost,
              state, source, last_reconciled_at
         FROM sessions
        ORDER BY COALESCE(last_activity_at, started_at, '') DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as SessionRow[];
  return rows.map(plain);
}

/**
 * 会话列表（PRD §11.1）：会话本身 + 首条用户消息摘要。
 *
 * 文件头里没有会话名，`sessions.name` 只有实时路径将来可能填；列表要有一列能看出
 * 「这个会话在做什么」，只能取第一条 `role=user` 的正文（截到 120 字符，行内还会再省略）。
 */
export function listSessionItems(limit = 200, db: Db = getDb()): SessionListItem[] {
  const sessions = listSessions(db, limit);
  const firstUserTexts = sessionFirstUserTexts(db);
  return sessions.map((session) => ({
    ...session,
    first_user_text: firstUserTexts.get(session.session_id) ?? null,
  }));
}

/** 每个会话第一条用户消息的摘要；没有用户消息的会话不在 Map 里 */
function sessionFirstUserTexts(db: Db): Map<string, string | null> {
  const rows = db
    .prepare(
      `SELECT m.session_id AS session_id, substr(m.text, 1, 120) AS text
         FROM messages m
         JOIN (
                SELECT session_id, MIN(entry_index) AS first_index
                  FROM messages
                 WHERE kind = 'message' AND role = 'user'
                 GROUP BY session_id
              ) f
           ON f.session_id = m.session_id AND f.first_index = m.entry_index
        WHERE m.kind = 'message' AND m.role = 'user'`,
    )
    .all() as unknown as { session_id: string; text: string | null }[];
  return new Map(rows.map((row) => [row.session_id, row.text]));
}

export function countSessions(db: Db = getDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
  return row.n;
}

/**
 * 列表页概览条（PRD §11.1）。「今日」= 服务器本地时区的今天 0 点起：
 *
 *   - 今日事件：按 `events.received_at`（服务端收到的时间）——回填不写事件，所以这里只反映实时活动；
 *   - 今日 token / 成本：按 `turns.started_at` 求和（实时与回填的 turn 都有开始时间）；
 *   - 累计丢弃：探针自报的累计值，不是今日；
 *   - 最近对账：`sessions.last_reconciled_at` 的最大值，M2-5 落地前一直是 NULL。
 */
export function overviewStats(db: Db = getDb(), now: Date = new Date()): OverviewStats {
  const since = localDayStartIso(now);
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM events WHERE received_at >= ?)                   AS events_today,
         (SELECT COALESCE(SUM(tokens_in), 0) FROM turns WHERE started_at >= ?)  AS tokens_in_today,
         (SELECT COALESCE(SUM(tokens_out), 0) FROM turns WHERE started_at >= ?) AS tokens_out_today,
         (SELECT COALESCE(SUM(cost), 0) FROM turns WHERE started_at >= ?)       AS cost_today,
         COALESCE((SELECT dropped_count FROM probe_status WHERE id = 1), 0)    AS dropped_total,
         (SELECT COUNT(*) FROM sessions WHERE source = 'backfill')              AS unreconciled_sessions,
         (SELECT MAX(last_reconciled_at) FROM sessions)                         AS last_reconciled_at`,
    )
    .get(since, since, since, since) as unknown as OverviewStats;
  return plain(row);
}

export function getSession(sessionId: string, db: Db = getDb()): SessionRow | null {
  const row = db
    .prepare(
      `SELECT session_id, cwd, file_path, parent_session, name, started_at, last_activity_at,
              message_count, turn_count, tool_call_count, tokens_in, tokens_out, cost,
              state, source, last_reconciled_at
         FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as unknown as SessionRow | undefined;
  return row ? plain(row) : null;
}

export interface EventQuery {
  limit?: number;
  layer?: string;
  eventType?: string;
  /** 只看这条 id 之后的事件，供实时增量拉取 */
  afterId?: number;
}

export function listEvents(sessionId: string, query: EventQuery = {}, db: Db = getDb()): EventRow[] {
  const limit = Math.min(Math.max(query.limit ?? 500, 1), 2000);
  const clauses = ["session_id = ?"];
  const params: unknown[] = [sessionId];
  if (query.layer) {
    clauses.push("layer = ?");
    params.push(query.layer);
  }
  if (query.eventType) {
    clauses.push("event_type = ?");
    params.push(query.eventType);
  }
  if (typeof query.afterId === "number") {
    clauses.push("id > ?");
    params.push(query.afterId);
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT id, event_id, session_id, layer, event_type, run_seq, turn_index, payload, occurred_at, received_at
         FROM events
        WHERE ${clauses.join(" AND ")}
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(...(params as never[])) as unknown as Array<Omit<EventRow, "payload"> & { payload: string | null }>;

  return rows.map((row) =>
    plain({
      ...row,
      payload: row.payload === null ? null : safeParse(row.payload),
    }),
  );
}

export function listTurns(sessionId: string, limit = 200, db: Db = getDb()): TurnRow[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, run_seq, turn_index, message_entry_id, started_at, ended_at,
              stop_reason, thinking_level, tokens_in, tokens_out, cost
         FROM turns WHERE session_id = ?
        ORDER BY run_seq ASC, turn_index ASC
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as TurnRow[];
  return rows.map(plain);
}

export function listToolCalls(sessionId: string, limit = 200, db: Db = getDb()): ToolCallRow[] {
  const rows = db
    .prepare(
      `SELECT tool_call_id, session_id, tool_name, is_error, duration_ms, started_at, ended_at
         FROM tool_calls WHERE session_id = ?
        ORDER BY COALESCE(started_at, '') ASC
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as ToolCallRow[];
  return rows.map(plain);
}

/**
 * 消息树的条目索引（PRD §11.2）：不带 payload，`text` 也截到 200 字符。
 * 一个会话可能有很多条目，整页塞进 payload 会让首屏变得很大；全文点击时再取。
 */
export function listMessageIndex(sessionId: string, limit = 5000, db: Db = getDb()): MessageIndexRow[] {
  const rows = db
    .prepare(
      `SELECT entry_id, parent_id, kind, role, timestamp, entry_index,
              substr(text, 1, ${SUMMARY_CHARS}) AS summary,
              COALESCE(LENGTH(payload), 0) AS payload_bytes
         FROM messages WHERE session_id = ?
        ORDER BY entry_index ASC
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as MessageIndexRow[];
  return rows.map(plain);
}

/** 会话在库里的条目总数，用于如实说明树有没有被 `limit` 截断 */
export function countMessages(sessionId: string, db: Db = getDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId) as { n: number };
  return row.n;
}

/** 单条条目的全文与原始 JSON（点击树节点时按需取） */
export function getMessageDetail(sessionId: string, entryId: string, db: Db = getDb()): MessageDetail | null {
  const row = db
    .prepare(
      `SELECT entry_id, kind, role, timestamp, entry_index, text,
              COALESCE(LENGTH(payload), 0) AS payload_bytes, payload
         FROM messages WHERE session_id = ? AND entry_id = ?`,
    )
    .get(sessionId, entryId) as unknown as Omit<MessageDetail, "payload"> & { payload: string | null } | undefined;
  if (row === undefined) return null;
  return plain({
    ...row,
    payload: row.payload === null ? null : safeParse(row.payload),
  });
}

export function probeStatus(db: Db = getDb()): ProbeStatusRow | null {
  const row = db
    .prepare("SELECT last_seen_at, dropped_count, queue_depth, probe_version FROM probe_status WHERE id = 1")
    .get() as unknown as ProbeStatusRow | undefined;
  return row ? plain(row) : null;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
