import { config } from "./config.ts";
import { Db, withTx } from "./db.ts";
import { log } from "./log.ts";
import {
  PROBE_PROTOCOL_VERSION,
  type EventLayer,
  type IngestBatch,
  type IngestRecord,
  type IngestResponse,
} from "./protocol.ts";
import { redact, serializeCapped } from "./redact.ts";
import { broadcast } from "./sse.ts";

export type ParseResult = { ok: true; batch: IngestBatch } | { ok: false; error: string };

const KINDS = new Set(["session", "run", "event", "turn", "tool_call", "request"]);
const EVENT_LAYERS = new Set<EventLayer>(["session", "agent", "tool", "provider"]);
const MAX_RECORDS_PER_BATCH = 1000;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function req(value: unknown, field: string, errors: string[], at: number): string {
  const v = str(value);
  if (v === null) errors.push(`records[${at}].${field} 缺失或不是非空字符串`);
  return v ?? "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function intOrNull(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

function boolInt(value: unknown): number {
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

/** 三态布尔：null / 缺失保留为 null，供 upsert 的 COALESCE 判断「本次没带这个值」 */
function boolOrNull(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/**
 * 手写校验（技术选型 T7）。只做形态校验：类型对不对、必填在不在。
 * 业务合理性（例如 run_seq 是否连续）由数据库约束与界面呈现负责。
 */
export function parseBatch(raw: unknown): ParseResult {
  if (!isObj(raw)) return { ok: false, error: "请求体不是对象" };

  const protocol = num(raw.protocol);
  if (protocol !== PROBE_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `协议版本不匹配：服务端 ${PROBE_PROTOCOL_VERSION}，探针 ${String(raw.protocol)}。请同步升级探针`,
    };
  }

  const records = raw.records;
  if (!Array.isArray(records)) return { ok: false, error: "records 不是数组" };
  if (records.length === 0) return { ok: false, error: "records 为空" };
  if (records.length > MAX_RECORDS_PER_BATCH) {
    return { ok: false, error: `records 超过单批上限 ${MAX_RECORDS_PER_BATCH}` };
  }

  const errors: string[] = [];
  const checked: IngestRecord[] = [];

  records.forEach((item, at) => {
    if (!isObj(item)) {
      errors.push(`records[${at}] 不是对象`);
      return;
    }
    const kind = str(item.kind);
    if (kind === null || !KINDS.has(kind)) {
      errors.push(`records[${at}].kind 未知：${String(item.kind)}`);
      return;
    }

    switch (kind) {
      case "session": {
        checked.push({
          kind: "session",
          session_id: req(item.session_id, "session_id", errors, at),
          cwd: str(item.cwd) ?? "",
          file_path: str(item.file_path),
          parent_session: str(item.parent_session),
          version: intOrNull(item.version),
          name: str(item.name),
          started_at: str(item.started_at),
          last_activity_at: str(item.last_activity_at),
          state: (str(item.state) as "active" | "idle" | "ended" | null) ?? "active",
          source: (str(item.source) as "live" | "backfill" | "merged" | null) ?? "live",
        });
        break;
      }
      case "run": {
        const runSeq = intOrNull(item.run_seq);
        if (runSeq === null) errors.push(`records[${at}].run_seq 缺失`);
        checked.push({
          kind: "run",
          session_id: req(item.session_id, "session_id", errors, at),
          run_seq: runSeq ?? 0,
          started_at: str(item.started_at),
          ended_at: str(item.ended_at),
          outcome: (str(item.outcome) as "completed" | "aborted" | "error" | null) ?? null,
        });
        break;
      }
      case "event": {
        const layer = str(item.layer);
        if (layer === null || !EVENT_LAYERS.has(layer as EventLayer)) {
          errors.push(`records[${at}].layer 未知：${String(item.layer)}`);
        }
        checked.push({
          kind: "event",
          event_id: req(item.event_id, "event_id", errors, at),
          session_id: req(item.session_id, "session_id", errors, at),
          layer: (layer ?? "session") as EventLayer,
          event_type: req(item.event_type, "event_type", errors, at),
          payload: item.payload ?? null,
          occurred_at: str(item.occurred_at),
          run_seq: intOrNull(item.run_seq),
          turn_index: intOrNull(item.turn_index),
        });
        break;
      }
      case "turn": {
        const runSeq = intOrNull(item.run_seq);
        const turnIndex = intOrNull(item.turn_index);
        if (runSeq === null) errors.push(`records[${at}].run_seq 缺失`);
        if (turnIndex === null) errors.push(`records[${at}].turn_index 缺失`);
        checked.push({
          kind: "turn",
          session_id: req(item.session_id, "session_id", errors, at),
          run_seq: runSeq ?? 0,
          turn_index: turnIndex ?? 0,
          message_entry_id: req(item.message_entry_id, "message_entry_id", errors, at),
          started_at: str(item.started_at),
          ended_at: str(item.ended_at),
          stop_reason: str(item.stop_reason),
          thinking_level: str(item.thinking_level),
          tokens_in: intOrNull(item.tokens_in),
          tokens_out: intOrNull(item.tokens_out),
          cache_read: intOrNull(item.cache_read),
          cache_write: intOrNull(item.cache_write),
          cost: num(item.cost),
        });
        break;
      }
      case "tool_call": {
        checked.push({
          kind: "tool_call",
          tool_call_id: req(item.tool_call_id, "tool_call_id", errors, at),
          session_id: req(item.session_id, "session_id", errors, at),
          parent_tool_call_id: str(item.parent_tool_call_id),
          tool_name: str(item.tool_name) ?? "",
          is_error: item.is_error === true || item.is_error === 1,
          duration_ms: intOrNull(item.duration_ms),
          started_at: str(item.started_at),
          ended_at: str(item.ended_at),
          run_seq: intOrNull(item.run_seq),
          turn_index: intOrNull(item.turn_index),
          entry_id: str(item.entry_id),
          result_entry_id: str(item.result_entry_id),
        });
        break;
      }
      case "request": {
        const requestSeq = intOrNull(item.request_seq);
        if (requestSeq === null) errors.push(`records[${at}].request_seq 缺失`);
        if (requestSeq !== null && requestSeq < 1) errors.push(`records[${at}].request_seq 必须大于 0`);
        checked.push({
          kind: "request",
          session_id: req(item.session_id, "session_id", errors, at),
          request_seq: requestSeq ?? 0,
          provider: str(item.provider),
          api: str(item.api),
          model: str(item.model),
          payload: item.payload ?? null,
          payload_bytes: intOrNull(item.payload_bytes),
          payload_truncated: boolOrNull(item.payload_truncated),
          status: intOrNull(item.status),
          response_headers: item.response_headers ?? null,
          // 目前只有一种关联方式；显式写出来，避免以后忘记这里是假设
          correlation: "serial_assumed",
          created_at: req(item.created_at, "created_at", errors, at),
          run_seq: intOrNull(item.run_seq),
          turn_index: intOrNull(item.turn_index),
        });
        break;
      }
    }
  });

  if (errors.length > 0) return { ok: false, error: errors.slice(0, 5).join("; ") };

  return {
    ok: true,
    batch: {
      protocol: PROBE_PROTOCOL_VERSION,
      probe_version: str(raw.probe_version) ?? "unknown",
      dropped_count: intOrNull(raw.dropped_count) ?? 0,
      queue_depth: intOrNull(raw.queue_depth) ?? 0,
      records: checked,
    },
  };
}

/**
 * 整批写在一个事务里，写完再广播 SSE（PRD §8.4）。
 *
 * `db` 故意**没有默认值**：写库的调用方必须明说自己写哪个库，
 * 否则测试里漏传时就会静默写进真实的 `data/observer.db`（踩过一次）。
 */
export function applyBatch(batch: IngestBatch, db: Db): IngestResponse {
  const maxPayload = config().payloadMaxBytes;
  const applied: Record<string, number> = {};
  const touched = new Set<string>();
  const now = new Date().toISOString();

  /**
   * null / undefined 必须落成 SQL NULL，不能落成字符串 "null"：
   * 否则 upsert 里的 `COALESCE(excluded.x, table.x)` 会认为「有新值」而覆盖旧值。
   */
  const jsonOrNull = (value: unknown): string | null =>
    value === null || value === undefined ? null : serializeCapped(value, maxPayload).json;

  /**
   * 请求 payload / 响应头在服务端再脱敏一次（防御纵深）：探针已经脱过，但服务端不能假设
   * 每个客户端都做对了——否则一个旧探针或手工请求就能把 authorization 原样写进库。
   * `payload_bytes` 仍是探针给的脱敏前原始长度，不受这里影响。
   */
  const redactedJsonOrNull = (value: unknown): string | null =>
    value === null || value === undefined ? null : serializeCapped(redact(value).value, maxPayload).json;

  const bump = (kind: string) => {
    applied[kind] = (applied[kind] ?? 0) + 1;
  };

  withTx(db, () => {
    const upsertSession = db.prepare(`
      INSERT INTO sessions (
        session_id, cwd, file_path, parent_session, version, name,
        started_at, last_activity_at, state, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        cwd = CASE WHEN excluded.cwd <> '' THEN excluded.cwd ELSE sessions.cwd END,
        file_path = COALESCE(excluded.file_path, sessions.file_path),
        parent_session = COALESCE(excluded.parent_session, sessions.parent_session),
        version = COALESCE(excluded.version, sessions.version),
        name = COALESCE(excluded.name, sessions.name),
        started_at = COALESCE(sessions.started_at, excluded.started_at),
        last_activity_at = CASE
          WHEN excluded.last_activity_at IS NULL THEN sessions.last_activity_at
          WHEN sessions.last_activity_at IS NULL THEN excluded.last_activity_at
          WHEN excluded.last_activity_at > sessions.last_activity_at THEN excluded.last_activity_at
          ELSE sessions.last_activity_at END,
        state = excluded.state,
        source = excluded.source
    `);

    const upsertRun = db.prepare(`
      INSERT INTO runs (session_id, run_seq, started_at, ended_at, outcome)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, run_seq) DO UPDATE SET
        started_at = COALESCE(excluded.started_at, runs.started_at),
        ended_at = COALESCE(excluded.ended_at, runs.ended_at),
        outcome = COALESCE(excluded.outcome, runs.outcome)
    `);

    const upsertTurn = db.prepare(`
      INSERT INTO turns (
        session_id, run_seq, turn_index, message_entry_id, started_at, ended_at,
        stop_reason, thinking_level, tokens_in, tokens_out, cache_read, cache_write, cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_entry_id) DO UPDATE SET
        run_seq = excluded.run_seq,
        turn_index = excluded.turn_index,
        started_at = COALESCE(excluded.started_at, turns.started_at),
        ended_at = COALESCE(excluded.ended_at, turns.ended_at),
        stop_reason = COALESCE(excluded.stop_reason, turns.stop_reason),
        thinking_level = COALESCE(excluded.thinking_level, turns.thinking_level),
        tokens_in = COALESCE(excluded.tokens_in, turns.tokens_in),
        tokens_out = COALESCE(excluded.tokens_out, turns.tokens_out),
        cache_read = COALESCE(excluded.cache_read, turns.cache_read),
        cache_write = COALESCE(excluded.cache_write, turns.cache_write),
        cost = COALESCE(excluded.cost, turns.cost)
    `);

    const upsertTool = db.prepare(`
      INSERT INTO tool_calls (
        tool_call_id, session_id, parent_tool_call_id, tool_name, is_error,
        duration_ms, started_at, ended_at, run_seq, turn_index, entry_id, result_entry_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool_call_id) DO UPDATE SET
        tool_name = CASE WHEN excluded.tool_name <> '' THEN excluded.tool_name ELSE tool_calls.tool_name END,
        parent_tool_call_id = COALESCE(excluded.parent_tool_call_id, tool_calls.parent_tool_call_id),
        is_error = CASE WHEN excluded.is_error = 1 THEN 1 ELSE tool_calls.is_error END,
        duration_ms = COALESCE(excluded.duration_ms, tool_calls.duration_ms),
        started_at = COALESCE(tool_calls.started_at, excluded.started_at),
        ended_at = COALESCE(excluded.ended_at, tool_calls.ended_at),
        run_seq = COALESCE(excluded.run_seq, tool_calls.run_seq),
        turn_index = COALESCE(excluded.turn_index, tool_calls.turn_index),
        entry_id = COALESCE(excluded.entry_id, tool_calls.entry_id),
        result_entry_id = COALESCE(excluded.result_entry_id, tool_calls.result_entry_id)
    `);

    // 请求开始时写 payload，响应到达时用同一 (session_id, request_seq) 补状态码与 headers。
    // 更新记录里 payload / payload_bytes / payload_truncated 为 null：payload 用 COALESCE 保留，
    // 字节数与截断标记用 MAX 保留（两列 NOT NULL DEFAULT 0，传 0 不会冲掉请求时的值）。
    const upsertRequest = db.prepare(`
      INSERT INTO llm_requests (
        session_id, request_seq, provider, api, model, payload, payload_bytes,
        payload_truncated, status, response_headers, correlation, created_at, run_seq, turn_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, request_seq) DO UPDATE SET
        provider = COALESCE(excluded.provider, llm_requests.provider),
        api = COALESCE(excluded.api, llm_requests.api),
        model = COALESCE(excluded.model, llm_requests.model),
        payload = COALESCE(excluded.payload, llm_requests.payload),
        payload_bytes = MAX(llm_requests.payload_bytes, excluded.payload_bytes),
        payload_truncated = MAX(llm_requests.payload_truncated, excluded.payload_truncated),
        status = COALESCE(excluded.status, llm_requests.status),
        response_headers = COALESCE(excluded.response_headers, llm_requests.response_headers),
        run_seq = COALESCE(excluded.run_seq, llm_requests.run_seq),
        turn_index = COALESCE(excluded.turn_index, llm_requests.turn_index)
    `);

    // 普通事件幂等忽略：同一 event_id 重复推送时不覆盖首次落库的内容。
    const insertEvent = db.prepare(`
      INSERT INTO events (event_id, session_id, layer, event_type, run_seq, turn_index, payload, occurred_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `);

    for (const record of batch.records) {
      switch (record.kind) {
        case "session": {
          upsertSession.run(
            record.session_id,
            record.cwd,
            record.file_path,
            record.parent_session,
            record.version,
            record.name,
            record.started_at,
            record.last_activity_at,
            record.state,
            record.source,
          );
          touched.add(record.session_id);
          bump("session");
          break;
        }
        case "run": {
          upsertRun.run(
            record.session_id,
            record.run_seq,
            record.started_at,
            record.ended_at,
            record.outcome,
          );
          touched.add(record.session_id);
          bump("run");
          break;
        }
        case "turn": {
          upsertTurn.run(
            record.session_id,
            record.run_seq,
            record.turn_index,
            record.message_entry_id,
            record.started_at,
            record.ended_at,
            record.stop_reason,
            record.thinking_level,
            record.tokens_in,
            record.tokens_out,
            record.cache_read,
            record.cache_write,
            record.cost,
          );
          touched.add(record.session_id);
          bump("turn");
          break;
        }
        case "tool_call": {
          upsertTool.run(
            record.tool_call_id,
            record.session_id,
            record.parent_tool_call_id,
            record.tool_name,
            record.is_error ? 1 : 0,
            record.duration_ms,
            record.started_at,
            record.ended_at,
            record.run_seq,
            record.turn_index,
            record.entry_id,
            record.result_entry_id,
          );
          touched.add(record.session_id);
          bump("tool_call");
          break;
        }
        case "event": {
          insertEvent.run(
            record.event_id,
            record.session_id,
            record.layer,
            record.event_type,
            record.run_seq,
            record.turn_index,
            jsonOrNull(record.payload),
            record.occurred_at,
            now,
          );
          touched.add(record.session_id);
          bump("event");
          break;
        }
        case "request": {
          upsertRequest.run(
            record.session_id,
            record.request_seq,
            record.provider,
            record.api,
            record.model,
            redactedJsonOrNull(record.payload),
            record.payload_bytes ?? 0,
            record.payload_truncated === null ? 0 : record.payload_truncated ? 1 : 0,
            record.status,
            redactedJsonOrNull(record.response_headers),
            record.correlation,
            record.created_at,
            record.run_seq,
            record.turn_index,
          );
          touched.add(record.session_id);
          bump("request");
          break;
        }
      }
    }

    // 会话聚合与活跃时间：按受影响会话重算，避免增量计数漂移。
    for (const sessionId of touched) refreshSessionAggregates(db, sessionId);

    // 探针状态（单行）
    db.prepare(`
      INSERT INTO probe_status (id, last_seen_at, dropped_count, queue_depth, probe_version)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        dropped_count = excluded.dropped_count,
        queue_depth = excluded.queue_depth,
        probe_version = excluded.probe_version
    `).run(now, batch.dropped_count, batch.queue_depth, batch.probe_version);
  });

  for (const sessionId of touched) {
    broadcast("session.updated", { session_id: sessionId });
  }
  broadcast("probe.status", {
    last_seen_at: now,
    dropped_count: batch.dropped_count,
    queue_depth: batch.queue_depth,
    probe_version: batch.probe_version,
  });

  log("info", "ingest", "已写入一批", {
    records: batch.records.length,
    applied,
    sessions: touched.size,
    dropped_count: batch.dropped_count,
  });

  return { ok: true, accepted: batch.records.length, applied, rejected: 0 };
}

/**
 * 重算一个会话的聚合列（PRD §8.4）。实时写入与文件回填共用这一份定义，
 * 否则两条路径会给出不一致的计数。
 *
 * 三处需要解释的取值：
 *
 * 1. `message_count` 取文件条目数（`messages` 里 `kind = 'message'` 的行）。
 *    协议 v3 起事件不再携带消息正文，`message_start` 也不再推送，所以这里只有文件这一个口径；
 *    文件由启动扫描、进页面、每秒同步与 settle 对账持续补齐（PRD §9.1）。
 *
 * 2. `turn_count` / `tool_call_count` / token / 缓存 / 成本都从 turns 与 tool_calls 表求和，
 *    这两张表的持久键（`message_entry_id`、`tool_call_id`）在实时与回填之间是同一个，
 *    所以两条路径 upsert 到同一行，求和不会重复计算。
 *
 * 3. `last_activity_at` 取事件接收时间与文件条目时间戳的较晚者；
 *    纯回填的会话没有事件，只能靠文件时间戳。
 */
export function refreshSessionAggregates(db: Db, sessionId: string): void {
  db.prepare(`
    UPDATE sessions SET
      message_count = (SELECT COUNT(*) FROM messages
                        WHERE session_id = sessions.session_id AND kind = 'message'),
      turn_count = (SELECT COUNT(*) FROM turns WHERE session_id = sessions.session_id),
      tool_call_count = (SELECT COUNT(*) FROM tool_calls WHERE session_id = sessions.session_id),
      tokens_in = (SELECT COALESCE(SUM(tokens_in), 0) FROM turns WHERE session_id = sessions.session_id),
      tokens_out = (SELECT COALESCE(SUM(tokens_out), 0) FROM turns WHERE session_id = sessions.session_id),
      cache_read = (SELECT COALESCE(SUM(COALESCE(cache_read, json_extract(assistant_message, '$.usage.cacheRead'))), 0) FROM turns WHERE session_id = sessions.session_id),
      cache_write = (SELECT COALESCE(SUM(COALESCE(cache_write, json_extract(assistant_message, '$.usage.cacheWrite'))), 0) FROM turns WHERE session_id = sessions.session_id),
      cost = (SELECT COALESCE(SUM(cost), 0) FROM turns WHERE session_id = sessions.session_id),
      last_activity_at = COALESCE(
        (SELECT MAX(received_at) FROM events WHERE session_id = sessions.session_id),
        (SELECT MAX(timestamp) FROM messages WHERE session_id = sessions.session_id),
        sessions.last_activity_at
      )
    WHERE session_id = ?
  `).run(sessionId);
}
