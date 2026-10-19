import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Db, openDb } from "../src/lib/db.ts";
import { applyBatch, parseBatch } from "../src/lib/ingest.ts";
import { PROBE_PROTOCOL_VERSION, progressEventId, type IngestBatch } from "../src/lib/protocol.ts";
import { clearSubscribers, subscribe } from "../src/lib/sse.ts";

const OCCURRED = "2026-10-19T10:00:05.000Z";

function baseBatch(): IngestBatch {
  return {
    protocol: PROBE_PROTOCOL_VERSION,
    probe_version: "0.1.0",
    dropped_count: 3,
    queue_depth: 7,
    records: [
      {
        kind: "session",
        session_id: "s1",
        cwd: "/tmp/proj",
        file_path: "/tmp/s1.jsonl",
        parent_session: null,
        version: 3,
        name: "测试会话",
        started_at: "2026-10-19T10:00:00.000Z",
        last_activity_at: OCCURRED,
        state: "active",
        source: "live",
      },
      {
        kind: "run",
        session_id: "s1",
        run_seq: 1,
        started_at: "2026-10-19T10:00:01.000Z",
        ended_at: null,
        outcome: null,
      },
      {
        kind: "event",
        event_id: "ev_1",
        session_id: "s1",
        layer: "turn",
        event_type: "turn_start",
        payload: { turnIndex: 0 },
        occurred_at: OCCURRED,
        run_seq: 1,
        turn_index: 0,
      },
      {
        kind: "tool_call",
        tool_call_id: "tc_1",
        session_id: "s1",
        parent_tool_call_id: null,
        tool_name: "read",
        args: { path: "docs/prd-v0.2.md" },
        result: null,
        partial_result: null,
        is_error: false,
        duration_ms: null,
        started_at: OCCURRED,
        ended_at: null,
      },
      {
        kind: "turn",
        session_id: "s1",
        run_seq: 1,
        turn_index: 0,
        message_entry_id: "msg_1",
        started_at: "2026-10-19T10:00:01.000Z",
        ended_at: "2026-10-19T10:00:06.000Z",
        stop_reason: "stop",
        thinking_level: "medium",
        assistant_message: { role: "assistant", content: [{ type: "text", text: "你好" }] },
        tool_results: [{ toolCallId: "tc_1", isError: false }],
        tokens_in: 100,
        tokens_out: 20,
        cost: 0.01,
      },
    ],
  };
}

function count(db: Db, table: string, where = "1 = 1"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number };
  return row.n;
}

function tempDb(): { db: Db; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-ingest-"));
  return {
    db: openDb(join(dir, "observer.db")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("parseBatch：协议版本不匹配直接拒绝", () => {
  const result = parseBatch({ protocol: PROBE_PROTOCOL_VERSION + 1, records: [{ kind: "session" }] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /协议版本不匹配/);
});

test("parseBatch：形状不合法的批次列出前几条错误", () => {
  const result = parseBatch({
    protocol: PROBE_PROTOCOL_VERSION,
    records: [{ kind: "session", session_id: "" }, { kind: "nope" }, "字符串"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /session_id|kind/);
});

test("parseBatch：事件层名不合法会被拦住", () => {
  const result = parseBatch({
    protocol: PROBE_PROTOCOL_VERSION,
    records: [{ kind: "event", event_id: "e1", session_id: "s1", event_type: "x", layer: "unknown" }],
  });
  assert.equal(result.ok, false);
});

test("parseBatch：合法批次通过并补齐默认值", () => {
  const result = parseBatch({
    protocol: PROBE_PROTOCOL_VERSION,
    probe_version: "0.1.0",
    records: [
      {
        kind: "event",
        event_id: "e1",
        session_id: "s1",
        layer: "turn",
        event_type: "turn_start",
        payload: {},
        occurred_at: OCCURRED,
        run_seq: 2,
        turn_index: 3,
      },
    ],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.batch.dropped_count, 0);
    assert.equal(result.batch.queue_depth, 0);
    const record = result.batch.records[0];
    assert.equal(record.kind, "event");
  }
});

test("applyBatch：五张表都落库，会话聚合被重算", () => {
  const { db, cleanup } = tempDb();
  try {
    const result = applyBatch(baseBatch(), db);
    assert.equal(result.accepted, 5);
    assert.equal(count(db, "sessions"), 1);
    assert.equal(count(db, "runs"), 1);
    assert.equal(count(db, "turns"), 1);
    assert.equal(count(db, "tool_calls"), 1);
    assert.equal(count(db, "events"), 1);

    const session = db
      .prepare("SELECT turn_count, tool_call_count, tokens_in, tokens_out, cost FROM sessions WHERE session_id = 's1'")
      .get() as Record<string, unknown>;
    // node:sqlite 返回的是 null 原型对象，deepStrictEqual 前先摊平成普通对象
    assert.deepEqual({ ...session }, { turn_count: 1, tool_call_count: 1, tokens_in: 100, tokens_out: 20, cost: 0.01 });

    const probe = db.prepare("SELECT dropped_count, queue_depth, probe_version FROM probe_status WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    assert.deepEqual({ ...probe }, { dropped_count: 3, queue_depth: 7, probe_version: "0.1.0" });
  } finally {
    db.close();
    cleanup();
  }
});

test("applyBatch：同一批推两次不产生重复行（幂等）", () => {
  const { db, cleanup } = tempDb();
  try {
    applyBatch(baseBatch(), db);
    applyBatch(baseBatch(), db);

    assert.equal(count(db, "events"), 1);
    assert.equal(count(db, "turns"), 1);
    assert.equal(count(db, "tool_calls"), 1);
    assert.equal(count(db, "runs"), 1);
    assert.equal(count(db, "sessions"), 1);
  } finally {
    db.close();
    cleanup();
  }
});

test("applyBatch：turn 与 tool_call 按持久键 upsert，后到的字段补齐", () => {
  const { db, cleanup } = tempDb();
  try {
    applyBatch(baseBatch(), db);

    const followUp: IngestBatch = {
      protocol: PROBE_PROTOCOL_VERSION,
      probe_version: "0.1.0",
      dropped_count: 3,
      queue_depth: 0,
      records: [
        {
          kind: "tool_call",
          tool_call_id: "tc_1",
          session_id: "s1",
          parent_tool_call_id: null,
          tool_name: "read",
          args: null,
          result: { bytes: 8421 },
          partial_result: null,
          is_error: false,
          duration_ms: 186,
          started_at: null,
          ended_at: "2026-10-19T10:00:05.500Z",
        },
      ],
    };
    applyBatch(followUp, db);

    const tool = db
      .prepare("SELECT args, result, duration_ms FROM tool_calls WHERE tool_call_id = 'tc_1'")
      .get() as { args: string; result: string; duration_ms: number };
    assert.equal(tool.duration_ms, 186);
    assert.equal(JSON.parse(tool.result).bytes, 8421);
    // args 传 null 时保留 start 阶段写入的原值
    assert.equal(JSON.parse(tool.args).path, "docs/prd-v0.2.md");
    assert.equal(count(db, "tool_calls"), 1);
  } finally {
    db.close();
    cleanup();
  }
});

test("applyBatch：进度快照按确定性 event_id 覆盖同一行", () => {
  const { db, cleanup } = tempDb();
  try {
    const progress = (text: string, updateCount: number): IngestBatch => ({
      protocol: PROBE_PROTOCOL_VERSION,
      probe_version: "0.1.0",
      dropped_count: 0,
      queue_depth: 0,
      records: [
        {
          kind: "progress",
          session_id: "s1",
          run_seq: 1,
          turn_index: 0,
          text,
          update_count: updateCount,
          started_at: OCCURRED,
        },
      ],
    });

    applyBatch(progress("第一段", 10), db);
    applyBatch(progress("第一段 第二段", 25), db);

    assert.equal(count(db, "events", "event_type = 'message_progress'"), 1);
    const row = db
      .prepare("SELECT event_id, payload, run_seq, turn_index FROM events WHERE event_type = 'message_progress'")
      .get() as { event_id: string; payload: string; run_seq: number; turn_index: number };
    assert.equal(row.event_id, progressEventId("s1", 1, 0));
    assert.equal(row.run_seq, 1);
    assert.equal(row.turn_index, 0);
    const payload = JSON.parse(row.payload) as { text: string; update_count: number; bytes: number };
    assert.equal(payload.text, "第一段 第二段");
    assert.equal(payload.update_count, 25);
    assert.ok(payload.bytes > 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("applyBatch：写入后按会话广播 SSE", () => {
  const seen: string[] = [];
  const unsubscribe = subscribe((event) => seen.push(event.event));
  try {
    const { db, cleanup } = tempDb();
    try {
      applyBatch(baseBatch(), db);
    } finally {
      db.close();
      cleanup();
    }
    assert.ok(seen.includes("session.updated"));
    assert.ok(seen.includes("probe.status"));
  } finally {
    unsubscribe();
    clearSubscribers();
  }
});

test("applyBatch：超过 512 KB 的消息被截断成合法 JSON 标记", () => {
  const { db, cleanup } = tempDb();
  try {
    const batch = baseBatch();
    const turn = batch.records.find((record) => record.kind === "turn");
    assert.ok(turn && turn.kind === "turn");
    turn.assistant_message = { role: "assistant", content: "x".repeat(600 * 1024) };
    applyBatch(batch, db);

    const row = db.prepare("SELECT assistant_message FROM turns WHERE message_entry_id = 'msg_1'").get() as {
      assistant_message: string;
    };
    const parsed = JSON.parse(row.assistant_message) as { truncated?: boolean; bytes?: number };
    assert.equal(parsed.truncated, true);
    assert.ok((parsed.bytes ?? 0) > 512 * 1024);
  } finally {
    db.close();
    cleanup();
  }
});
