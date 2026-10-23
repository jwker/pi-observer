import { Db, getDb } from "./db.ts";
import { localDayStartIso } from "./session-view.ts";
import type {
  EventRow,
  MessageDetail,
  OverviewStats,
  ProbeStatusRow,
  RequestDetail,
  RequestIndexRow,
  SessionCursorRow,
  SessionListItem,
  SessionRow,
  SessionStreamData,
  TimelineMessageRow,
  ToolCallDetail,
  ToolCallIndexRow,
  TurnRow,
} from "./types.ts";

export type {
  EventRow,
  MessageDetail,
  OverviewStats,
  ProbeStatusRow,
  RequestDetail,
  RequestIndexRow,
  SessionCursorRow,
  SessionListItem,
  SessionRow,
  SessionStreamData,
  TimelineMessageRow,
  ToolCallDetail,
  ToolCallIndexRow,
  TurnRow,
} from "./types.ts";

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
              message_count, turn_count, tool_call_count, tokens_in, tokens_out,
              cache_read, cache_write, cost,
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

/** 会话已有数据的最大序号；探针本地游标缺失时用它种子化，避免 --resume 后从 1 覆盖旧运行 / 请求 */
export function sessionCursor(sessionId: string, db: Db = getDb()): SessionCursorRow {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT MAX(request_seq) FROM llm_requests WHERE session_id = ?), 0) AS request_seq_max,
         MAX(
           COALESCE((SELECT MAX(run_seq) FROM runs WHERE session_id = ?), 0),
           COALESCE((SELECT MAX(run_seq) FROM turns WHERE session_id = ?), 0)
         ) AS run_seq_max`,
    )
    .get(sessionId, sessionId, sessionId) as unknown as SessionCursorRow;
  return plain(row);
}

export function getSession(sessionId: string, db: Db = getDb()): SessionRow | null {
  const row = db
    .prepare(
      `SELECT session_id, cwd, file_path, parent_session, name, started_at, last_activity_at,
              message_count, turn_count, tool_call_count, tokens_in, tokens_out,
              cache_read, cache_write, cost,
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
  /** 默认按 id 升序；时间线取最近事件时用 `desc`，再按 id 降序取满 */
  order?: "asc" | "desc";
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
      `SELECT id, event_id, session_id, layer, event_type, run_seq, turn_index,
              payload_path, payload_summary, occurred_at, received_at
         FROM events
        WHERE ${clauses.join(" AND ")}
        ORDER BY id ${query.order === "desc" ? "DESC" : "ASC"}
        LIMIT ?`,
    )
    .all(...(params as never[])) as unknown as Array<
    Omit<EventRow, "payload"> & { payload_summary: string | null }
  >;

  // payload 列里现在是截短后的骨架：时间线要从事件里取工具名、请求序号这类标签
  return rows.map((row) =>
    plain({
      ...row,
      payload: row.payload_summary === null ? null : safeParse(row.payload_summary),
    }),
  );
}

export function listTurns(
  sessionId: string,
  limit = 200,
  db: Db = getDb(),
  options: { recent?: boolean } = {},
): TurnRow[] {
  const recent = options.recent === true;
  const rows = db
    .prepare(
      `SELECT id, session_id, run_seq, turn_index, message_entry_id, started_at, ended_at,
              stop_reason, thinking_level, tokens_in, tokens_out, cost,
              COALESCE(cache_read, json_extract(assistant_message, '$.usage.cacheRead'))   AS cache_read,
              COALESCE(cache_write, json_extract(assistant_message, '$.usage.cacheWrite')) AS cache_write
         FROM turns WHERE session_id = ?
        ORDER BY run_seq ${recent ? "DESC" : "ASC"}, turn_index ${recent ? "DESC" : "ASC"}
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as TurnRow[];
  const plain_ = rows.map(plain);
  return recent ? plain_.reverse() : plain_;
}

/** 工具列表（PRD §11.2 视图三 / M3-4）：参数 / 结果按条目引用 join messages，只带字节数与参数预览 */
export function listToolCallIndex(
  sessionId: string,
  limit = 500,
  db: Db = getDb(),
  options: { recent?: boolean } = {},
): ToolCallIndexRow[] {
  const recent = options.recent === true;
  const rows = db
    .prepare(
      `WITH resolved AS (
         SELECT tc.*,
                COALESCE(
                  (SELECT json_extract(j.value, '$.arguments')
                     FROM messages m, json_each(m.payload_summary, '$.message.content') j
                    WHERE m.session_id = tc.session_id
                      AND m.entry_id = tc.entry_id
                      AND json_extract(j.value, '$.type') = 'toolCall'
                      AND json_extract(j.value, '$.id') = tc.tool_call_id
                    LIMIT 1),
                  tc.args
                ) AS args_json,
                COALESCE(
                  (SELECT json_extract(m2.payload_summary, '$.message')
                     FROM messages m2
                    WHERE m2.session_id = tc.session_id
                      AND m2.entry_id = tc.result_entry_id),
                  tc.result
                ) AS result_json
           FROM tool_calls tc
          WHERE tc.session_id = ?
       )
       SELECT tool_call_id, session_id, parent_tool_call_id, tool_name, is_error, duration_ms,
              started_at, ended_at, run_seq, turn_index, entry_id, result_entry_id,
              COALESCE(LENGTH(CAST(args_json AS TEXT)), 0) AS args_bytes,
              COALESCE(LENGTH(CAST(result_json AS TEXT)), 0) AS result_bytes,
              substr(CAST(args_json AS TEXT), 1, 200) AS args_preview,
              CASE WHEN json_valid(result_json)
                   THEN substr(json_extract(result_json, '$.content[0].text'), 1, 200) END AS result_preview
         FROM resolved
        ORDER BY COALESCE(started_at, '') ${recent ? "DESC" : "ASC"}
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as ToolCallIndexRow[];
  const plain_ = rows.map(plain);
  return recent ? plain_.reverse() : plain_;
}

export function countToolCalls(sessionId: string, db: Db = getDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?").get(sessionId) as { n: number };
  return row.n;
}

/** 单条工具调用详情（点击列表时进详情页，按需取完整参数与结果） */
export function getToolCallDetail(sessionId: string, toolCallId: string, db: Db = getDb()): ToolCallDetail | null {
  const row = db
    .prepare(
      `WITH resolved AS (
         SELECT tc.*,
                COALESCE(
                  (SELECT json_extract(j.value, '$.arguments')
                     FROM messages m, json_each(m.payload_summary, '$.message.content') j
                    WHERE m.session_id = tc.session_id
                      AND m.entry_id = tc.entry_id
                      AND json_extract(j.value, '$.type') = 'toolCall'
                      AND json_extract(j.value, '$.id') = tc.tool_call_id
                    LIMIT 1),
                  tc.args
                ) AS args_json,
                COALESCE(
                  (SELECT json_extract(m2.payload_summary, '$.message')
                     FROM messages m2
                    WHERE m2.session_id = tc.session_id
                      AND m2.entry_id = tc.result_entry_id),
                  tc.result
                ) AS result_json
           FROM tool_calls tc
          WHERE tc.session_id = ? AND tc.tool_call_id = ?
       )
       SELECT tool_call_id, session_id, parent_tool_call_id, tool_name, is_error, duration_ms,
              started_at, ended_at, run_seq, turn_index, entry_id, result_entry_id,
              COALESCE(LENGTH(CAST(args_json AS TEXT)), 0) AS args_bytes,
              COALESCE(LENGTH(CAST(result_json AS TEXT)), 0) AS result_bytes,
              substr(CAST(args_json AS TEXT), 1, 200) AS args_preview,
              CASE WHEN json_valid(result_json)
                   THEN substr(json_extract(result_json, '$.content[0].text'), 1, 200) END AS result_preview,
              args_json AS args, result_json AS result
         FROM resolved`,
    )
    .get(sessionId, toolCallId) as
    | (Omit<ToolCallDetail, "args" | "result"> & {
        args: string | null;
        result: string | null;
      })
    | undefined;
  if (row === undefined) return null;
  return plain({
    ...row,
    args: row.args === null ? null : safeParse(row.args),
    result: row.result === null ? null : safeParse(row.result),
  }) as ToolCallDetail;
}

/**
 * 请求列表（PRD §11.2 视图二 / M3-3）。不再从 events 里找关联：请求记录自己在
 * `run_seq` / `turn_index` 上关联 turns，因此事件被 7 天清理后 token 与成本仍然可查。
 * 不取 payload 与 headers：单条 payload 可到 512 KB，列表只显示字节数。
 */
export function listRequests(sessionId: string, limit = 200, db: Db = getDb()): RequestIndexRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.session_id, r.request_seq, r.provider, r.api, r.model,
              r.payload_bytes, r.status, r.created_at,
              r.run_seq, r.turn_index,
              COALESCE(LENGTH(r.response_headers), 0) AS response_headers_bytes,
              t.tokens_in, t.tokens_out, t.cost
         FROM llm_requests r
         LEFT JOIN turns t
           ON t.id = (
                SELECT t2.id FROM turns t2
                 WHERE t2.session_id = r.session_id AND t2.run_seq = r.run_seq AND t2.turn_index = r.turn_index
                 ORDER BY t2.id DESC LIMIT 1
              )
        WHERE r.session_id = ?
        ORDER BY r.request_seq DESC
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as RequestIndexRow[];
  return rows.map(plain);
}

/** 会话的请求总数，用于如实说明列表有没有被 `limit` 截断 */
export function countRequests(sessionId: string, db: Db = getDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM llm_requests WHERE session_id = ?").get(sessionId) as { n: number };
  return row.n;
}

/** 单条请求详情（点击列表时进详情页，按需取 payload 与响应头） */
export function getRequestDetail(sessionId: string, requestSeq: number, db: Db = getDb()): RequestDetail | null {
  const row = db
    .prepare(
      `SELECT r.id, r.session_id, r.request_seq, r.provider, r.api, r.model,
              r.payload_bytes, r.status, r.created_at,
              r.run_seq, r.turn_index, r.correlation, r.payload_path, r.response_headers,
              COALESCE(LENGTH(r.response_headers), 0) AS response_headers_bytes,
              t.tokens_in, t.tokens_out, t.cost,
              t.started_at AS turn_started_at, t.ended_at AS turn_ended_at,
              t.stop_reason AS turn_stop_reason,
              COALESCE(json_extract(tm.payload_summary, '$.message.usage'),
                       json_extract(t.assistant_message, '$.usage')) AS turn_usage_json
         FROM llm_requests r
         LEFT JOIN turns t
           ON t.id = (
                SELECT t2.id FROM turns t2
                 WHERE t2.session_id = r.session_id AND t2.run_seq = r.run_seq AND t2.turn_index = r.turn_index
                 ORDER BY t2.id DESC LIMIT 1
              )
         LEFT JOIN messages tm
           ON tm.session_id = t.session_id AND tm.entry_id = t.message_entry_id
        WHERE r.session_id = ? AND r.request_seq = ?`,
    )
    .get(sessionId, requestSeq) as
    | (Omit<RequestDetail, "payload" | "response_headers" | "turn_usage"> & {
        payload_path: string | null;
        response_headers: string | null;
        turn_usage_json: string | null;
      })
    | undefined;
  if (row === undefined) return null;

  const usage = row.turn_usage_json === null ? null : safeParse(row.turn_usage_json);
  const { turn_usage_json: _usageJson, ...rest } = row;
  return plain({
    ...rest,
    // 正文在文件里，这里先给 null，由详情接口按 payload_path 读出来填上
    payload: null,
    response_headers: row.response_headers === null ? null : safeParse(row.response_headers),
    turn_usage: usage,
  }) as RequestDetail;
}

/**
 * 消息树的条目索引（PRD §11.2）：不带 payload，`text` 也截到 200 字符。
 * 一个会话可能有很多条目，整页塞进 payload 会让首屏变得很大；全文点击时再取。
 */
/** 会话在库里的条目总数，用于如实说明时间线有没有被 `limit` 截断 */
export function countMessages(sessionId: string, db: Db = getDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId) as { n: number };
  return row.n;
}

/** 单条条目的全文与原始 JSON（点击树节点时按需取） */
export function getMessageDetail(sessionId: string, entryId: string, db: Db = getDb()): MessageDetail | null {
  const row = db
    .prepare(
      `SELECT entry_id, parent_id, kind, role, timestamp, entry_index, text,
              COALESCE(LENGTH(payload_summary), 0) AS payload_bytes, payload_path, payload_summary
         FROM messages WHERE session_id = ? AND entry_id = ?`,
    )
    .get(sessionId, entryId) as unknown as
    | (Omit<MessageDetail, "payload"> & { payload_path: string | null; payload_summary: string | null })
    | undefined;
  if (row === undefined) return null;
  return plain({
    ...row,
    // 正文在文件里，详情接口按 payload_path 读出来填上；这里先给骨架
    payload: row.payload_summary === null ? null : safeParse(row.payload_summary),
  });
}

/**
 * 时间线条目（R2）：比消息树索引多带正文与思考摘要，但仍不带完整 payload。
 *
 * `thinking` 只取第一条 thinking 部分并截到 2 KB：时间线默认折叠思考，够显示摘要；
 * 完整思考在行详情里看原始 payload。`json_valid` 兜底截断过的 payload，避免 SQL 报错。
 */
export function listTimelineMessages(
  sessionId: string,
  limit = 20000,
  db: Db = getDb(),
  options: { recent?: boolean } = {},
): TimelineMessageRow[] {
  const recent = options.recent === true;
  const rows = db
    .prepare(
      `SELECT m.entry_id, m.parent_id, m.kind, m.role, m.timestamp, m.entry_index,
              substr(m.text, 1, 600) AS text,
              (SELECT substr(json_extract(j.value, '$.thinking'), 1, 400)
                 FROM json_each(CASE WHEN json_valid(m.payload_summary)
                                      AND json_type(m.payload_summary, '$.message.content') = 'array'
                                     THEN m.payload_summary ELSE '{}' END,
                                '$.message.content') j
                WHERE json_extract(j.value, '$.type') = 'thinking'
                LIMIT 1) AS thinking,
              COALESCE(LENGTH(m.payload_summary), 0) AS payload_bytes
         FROM messages m
        WHERE m.session_id = ?
        ORDER BY m.entry_index ${recent ? "DESC" : "ASC"}
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as TimelineMessageRow[];
  const plain_ = rows.map(plain);
  return recent ? plain_.reverse() : plain_;
}

export function countTurns(sessionId: string, db: Db = getDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(sessionId) as { n: number };
  return row.n;
}

export function countEvents(sessionId: string, db: Db = getDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(sessionId) as { n: number };
  return row.n;
}

/** 单条事件（行详情弹窗用）；payload 已解析 */
export function getEventDetail(sessionId: string, eventId: string, db: Db = getDb()): EventRow | null {
  const row = db
    .prepare(
      `SELECT id, event_id, session_id, layer, event_type, run_seq, turn_index,
              payload_path, payload_summary, occurred_at, received_at
         FROM events WHERE session_id = ? AND event_id = ?`,
    )
    .get(sessionId, eventId) as unknown as
    | (Omit<EventRow, "payload"> & { payload_path: string | null; payload_summary: string | null })
    | undefined;
  if (row === undefined) return null;
  return plain({
    ...row,
    // 正文在文件里，详情接口按 payload_path 读出来填上；这里先给骨架
    payload: row.payload_summary === null ? null : safeParse(row.payload_summary),
  }) as EventRow;
}

/**
 * 单页时间线一次取全（R2）：消息条目、Turn 元数据、事件、工具、请求索引。
 * 请求只取索引，不带 payload / headers；行详情弹窗再用 `getRequestDetail`。
 *
 * 数组有条数上限，`totals` 是库里的真实行数：调用方发现长度小于总数时要如实说明截断。
 * 本机单用户、最大会话约几百条，上限只是防御，正常不会触发。
 */
/**
 * 单页每秒轮询用的轻量版本号（R3）。
 *
 * 活跃会话每秒可能只多几条条目；每秒把整套 `sessionStreamData` 序列化一遍太浪费。
 * 这里只聚合计数、最大序号、字节数、状态与最后时间，拼成一个短字符串：
 * 与上一次相同就返回 `unchanged`，页面不做任何渲染。它不要求严格单调，只要求
 * 「库里的可见数据变了，字符串就一定变」——所以时间字段和聚合值都放进去。
 */
export function streamVersion(sessionId: string, db: Db = getDb()): string | null {
  const session = db
    .prepare(
      `SELECT state, source, COALESCE(last_activity_at, '') AS last_activity_at,
              COALESCE(last_reconciled_at, '') AS last_reconciled_at,
              message_count, turn_count, tool_call_count, tokens_in, tokens_out, cost
         FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        state: string;
        source: string;
        last_activity_at: string;
        last_reconciled_at: string;
        message_count: number;
        turn_count: number;
        tool_call_count: number;
        tokens_in: number;
        tokens_out: number;
        cost: number;
      }
    | undefined;
  if (session === undefined) return null;

  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM messages WHERE session_id = ?)                          AS messages,
         (SELECT COALESCE(MAX(entry_index), -1) FROM messages WHERE session_id = ?)    AS message_index,
         (SELECT COALESCE(SUM(LENGTH(payload_summary)), 0) FROM messages WHERE session_id = ?) AS message_bytes,
         (SELECT COUNT(*) FROM events WHERE session_id = ?)                            AS events,
         (SELECT COALESCE(MAX(id), 0) FROM events WHERE session_id = ?)                AS event_id,
         (SELECT COUNT(*) FROM turns WHERE session_id = ?)                             AS turns,
         (SELECT COALESCE(MAX(id), 0) FROM turns WHERE session_id = ?)                 AS turn_id,
         (SELECT COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) + COALESCE(cost, 0)), 0)
            FROM turns WHERE session_id = ?)                                           AS turn_usage,
         (SELECT COALESCE(MAX(ended_at), '') FROM turns WHERE session_id = ?)           AS turn_ended,
         (SELECT COUNT(*) FROM tool_calls WHERE session_id = ?)                        AS tools,
         (SELECT COALESCE(SUM(is_error), 0) FROM tool_calls WHERE session_id = ?)      AS tool_errors,
         (SELECT COALESCE(SUM(COALESCE(duration_ms, 0)), 0) FROM tool_calls WHERE session_id = ?) AS tool_ms,
         (SELECT COALESCE(MAX(ended_at), '') FROM tool_calls WHERE session_id = ?)      AS tool_ended,
         (SELECT COUNT(*) FROM llm_requests WHERE session_id = ?)                      AS requests,
         (SELECT COALESCE(MAX(id), 0) FROM llm_requests WHERE session_id = ?)          AS request_id,
         (SELECT COALESCE(SUM(COALESCE(status, 0)), 0) FROM llm_requests WHERE session_id = ?) AS request_status,
         (SELECT COALESCE(SUM(COALESCE(LENGTH(response_headers), 0)), 0)
            FROM llm_requests WHERE session_id = ?)                                    AS request_headers`,
    )
    .get(
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
    ) as Record<string, number>;

  return [
    session.state,
    session.source,
    session.last_activity_at,
    session.last_reconciled_at,
    session.message_count,
    session.turn_count,
    session.tool_call_count,
    session.tokens_in,
    session.tokens_out,
    session.cost,
    row.messages,
    row.message_index,
    row.message_bytes,
    row.events,
    row.event_id,
    row.turns,
    row.turn_id,
    row.turn_usage,
    row.turn_ended,
    row.tools,
    row.tool_errors,
    row.tool_ms,
    row.tool_ended,
    row.requests,
    row.request_id,
    row.request_status,
    row.request_headers,
  ].join("|");
}

/**
 * 取一个会话的时间线数据。
 *
 * `live` 模式只取最近的一段（最近的消息 / Turn / 事件 / 工具 / 请求），
 * 客户端与已有数据合并后使用：实时刷新不必把整段历史重发一遍。
 * 长会话里这一段就是几百 KB 对 1 MB 的差别。
 */
/** 实时刷新时每次带多少条（够覆盖一屏 Turn 还要有余量）。 */
export const LIVE_WINDOW = {
  messages: 300,
  turns: 80,
  events: 200,
  tools: 120,
  requests: 80,
} as const;

export function sessionStreamData(
  sessionId: string,
  db: Db = getDb(),
  options: { live?: boolean } = {},
): SessionStreamData | null {
  const session = getSession(sessionId, db);
  if (session === null) return null;

  const live = options.live === true;
  return {
    session,
    messages: listTimelineMessages(sessionId, live ? LIVE_WINDOW.messages : 20000, db, { recent: live }),
    turns: listTurns(sessionId, live ? LIVE_WINDOW.turns : 5000, db, { recent: live }),
    events: listEvents(sessionId, { limit: live ? LIVE_WINDOW.events : 2000, order: "desc" }, db),
    tools: listToolCallIndex(sessionId, live ? LIVE_WINDOW.tools : 5000, db, { recent: live }),
    requests: listRequests(sessionId, live ? LIVE_WINDOW.requests : 2000, db),
    totals: {
      messages: countMessages(sessionId, db),
      turns: countTurns(sessionId, db),
      events: countEvents(sessionId, db),
      tools: countToolCalls(sessionId, db),
      requests: countRequests(sessionId, db),
    },
  };
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
