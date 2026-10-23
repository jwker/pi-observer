import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Db, openDb } from "../src/lib/db.ts";
import { applyBatch, parseBatch } from "../src/lib/ingest.ts";
import { payloadRelPath, writePayloadFile } from "../src/lib/payload-files.ts";
import { PROBE_PROTOCOL_VERSION, type IngestBatch } from "../src/lib/protocol.ts";
import { clearSubscribers, subscribe } from "../src/lib/sse.ts";

const OCCURRED = "2026-10-19T10:00:05.000Z";

function baseBatch(): IngestBatch {
  return {
    protocol: PROBE_PROTOCOL_VERSION,
    probe_version: "0.3.0",
    dropped_count: 3,
    queue_depth: 7,
    payload_root: null,
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
        layer: "agent",
        event_type: "agent_start",
        payload_path: "event/s1/ev_1.json",
        occurred_at: OCCURRED,
        run_seq: 1,
        turn_index: null,
      },
      {
        kind: "tool_call",
        tool_call_id: "tc_1",
        session_id: "s1",
        parent_tool_call_id: null,
        tool_name: "read",
        is_error: false,
        duration_ms: null,
        started_at: OCCURRED,
        ended_at: null,
        run_seq: 1,
        turn_index: 0,
        entry_id: null,
        result_entry_id: null,
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
        tokens_in: 100,
        tokens_out: 20,
        cache_read: 300,
        cache_write: 40,
        cost: 0.01,
      },
    ],
  };
}

function count(db: Db, table: string, where = "1 = 1"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number };
  return row.n;
}

function tempDb(): { db: Db; payloadRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-ingest-"));
  const payloadRoot = join(dir, "payloads");
  mkdirSync(join(payloadRoot, "event", "s1"), { recursive: true });
  // 事件正文的文件：服务端据此生成时间线用的骨架
  writeFileSync(join(payloadRoot, "event", "s1", "ev_1.json"), JSON.stringify({ runSeq: 1 }), "utf8");
  return {
    db: openDb(join(dir, "observer.db")),
    payloadRoot,
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

test("parseBatch：v2 的 message / turn 事件层与 progress 记录不再接受", () => {
  const messageLayer = parseBatch({
    protocol: PROBE_PROTOCOL_VERSION,
    records: [{ kind: "event", event_id: "e1", session_id: "s1", event_type: "message_start", layer: "message" }],
  });
  assert.equal(messageLayer.ok, false);

  const progress = parseBatch({
    protocol: PROBE_PROTOCOL_VERSION,
    records: [{ kind: "progress", session_id: "s1", run_seq: 1, turn_index: 0, text: "abc" }],
  });
  assert.equal(progress.ok, false);
  if (!progress.ok) assert.match(progress.error, /kind 未知/);
});

test("parseBatch：合法批次通过并补齐默认值", () => {
  const result = parseBatch({
    protocol: PROBE_PROTOCOL_VERSION,
    probe_version: "0.3.0",
    records: [
      {
        kind: "event",
        event_id: "e1",
        session_id: "s1",
        layer: "agent",
        event_type: "agent_start",
        payload_path: null,
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
  const { db, payloadRoot, cleanup } = tempDb();
  try {
    const result = applyBatch(baseBatch(), db, payloadRoot);
    assert.equal(result.accepted, 5);
    assert.equal(count(db, "sessions"), 1);
    assert.equal(count(db, "runs"), 1);
    assert.equal(count(db, "turns"), 1);
    assert.equal(count(db, "tool_calls"), 1);
    assert.equal(count(db, "events"), 1);

    const session = db
      .prepare(
        "SELECT turn_count, tool_call_count, tokens_in, tokens_out, cache_read, cache_write, cost FROM sessions WHERE session_id = 's1'",
      )
      .get() as Record<string, unknown>;
    // node:sqlite 返回的是 null 原型对象，deepStrictEqual 前先摊平成普通对象
    assert.deepEqual(
      { ...session },
      { turn_count: 1, tool_call_count: 1, tokens_in: 100, tokens_out: 20, cache_read: 300, cache_write: 40, cost: 0.01 },
    );

    const probe = db.prepare("SELECT dropped_count, queue_depth, probe_version FROM probe_status WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    assert.deepEqual({ ...probe }, { dropped_count: 3, queue_depth: 7, probe_version: "0.3.0" });
  } finally {
    db.close();
    cleanup();
  }
});

test("applyBatch：同一批推两次不产生重复行（幂等）", () => {
  const { db, payloadRoot, cleanup } = tempDb();
  try {
    applyBatch(baseBatch(), db, payloadRoot);
    applyBatch(baseBatch(), db, payloadRoot);

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

test("applyBatch：turn 与 tool_call 按持久键 upsert，后到的标量补齐", () => {
  const { db, payloadRoot, cleanup } = tempDb();
  try {
    applyBatch(baseBatch(), db, payloadRoot);

    const followUp: IngestBatch = {
      protocol: PROBE_PROTOCOL_VERSION,
      probe_version: "0.3.0",
      dropped_count: 3,
      queue_depth: 0,
      payload_root: null,
      records: [
        {
          kind: "tool_call",
          tool_call_id: "tc_1",
          session_id: "s1",
          parent_tool_call_id: null,
          tool_name: "read",
          is_error: false,
          duration_ms: 186,
          started_at: null,
          ended_at: "2026-10-19T10:00:05.500Z",
          run_seq: null,
          turn_index: null,
          entry_id: "msg_1",
          result_entry_id: "res_1",
        },
        {
          kind: "turn",
          session_id: "s1",
          run_seq: 1,
          turn_index: 0,
          message_entry_id: "msg_1",
          started_at: null,
          ended_at: null,
          stop_reason: null,
          thinking_level: null,
          tokens_in: null,
          tokens_out: null,
          cache_read: 512,
          cache_write: null,
          cost: null,
        },
      ],
    };
    applyBatch(followUp, db);

    const tool = db
      .prepare("SELECT duration_ms, entry_id, result_entry_id, args, result FROM tool_calls WHERE tool_call_id = 'tc_1'")
      .get() as { duration_ms: number; entry_id: string; result_entry_id: string; args: string | null; result: string | null };
    assert.equal(tool.duration_ms, 186);
    assert.equal(tool.entry_id, "msg_1");
    assert.equal(tool.result_entry_id, "res_1");
    assert.equal(tool.args, null, "协议 v3 不再写参数副本");
    assert.equal(tool.result, null, "协议 v3 不再写结果副本");
    assert.equal(count(db, "tool_calls"), 1);

    const turn = db
      .prepare("SELECT cache_read, cache_write, tokens_in FROM turns WHERE message_entry_id = 'msg_1'")
      .get() as { cache_read: number; cache_write: number; tokens_in: number };
    assert.equal(turn.cache_read, 512, "后到的缓存计数覆盖旧值");
    assert.equal(turn.cache_write, 40, "没带的字段保留旧值");
    assert.equal(turn.tokens_in, 100);
  } finally {
    db.close();
    cleanup();
  }
});

test("applyBatch：请求开始时写 payload，响应到达后补状态码与 headers", () => {
  const { db, payloadRoot, cleanup } = tempDb();
  try {
    const start: IngestBatch = {
      protocol: PROBE_PROTOCOL_VERSION,
      probe_version: "0.3.0",
      dropped_count: 0,
      queue_depth: 0,
      payload_root: null,
      records: [
        {
          kind: "request",
          session_id: "s1",
          request_seq: 1,
          provider: "deepseek",
          api: "openai-completions",
          model: "deepseek-flash",
          payload_path: "request/s1/1.json",
          payload_bytes: 1234,
          status: null,
          response_headers: null,
          correlation: "serial_assumed",
          created_at: OCCURRED,
          run_seq: 3,
          turn_index: 2,
        },
      ],
    };
    applyBatch(start, db, payloadRoot);

    const select = () =>
      db.prepare("SELECT * FROM llm_requests WHERE session_id = 's1' AND request_seq = 1").get() as Record<string, unknown>;
    let row = select();
    assert.equal(row.payload_bytes, 1234);
    assert.equal(row.status, null);
    assert.equal(row.model, "deepseek-flash");
    assert.equal(row.run_seq, 3, "运行序号落库");
    assert.equal(row.turn_index, 2, "Turn 序号落库");
    assert.equal(row.payload_path, "request/s1/1.json", "正文只留路径");

    const response: IngestBatch = {
      protocol: PROBE_PROTOCOL_VERSION,
      probe_version: "0.3.0",
      dropped_count: 0,
      queue_depth: 0,
      payload_root: null,
      records: [
        {
          kind: "request",
          session_id: "s1",
          request_seq: 1,
          provider: null,
          api: null,
          model: null,
          payload_path: null,
          payload_bytes: null,
          status: 200,
          response_headers: { "content-type": "application/json", authorization: "secret-value" },
          correlation: "serial_assumed",
          created_at: "2026-10-19T10:00:02.000Z",
          run_seq: null,
          turn_index: null,
        },
      ],
    };
    applyBatch(response, db, payloadRoot);

    row = select();
    assert.equal(row.status, 200);
    assert.equal(row.payload_bytes, 1234, "响应更新不能把原始字节数冲掉");
    assert.equal(row.created_at, OCCURRED, "created_at 保留请求开始时间");
    assert.equal(row.run_seq, 3, "响应更新不能把运行序号冲掉");
    assert.equal(row.turn_index, 2, "响应更新不能把 Turn 序号冲掉");
    assert.equal(JSON.parse(row.response_headers as string)["content-type"], "application/json");
    assert.equal(JSON.parse(row.response_headers as string).authorization, "secret-value", "不再脱敏");
    assert.equal(count(db, "llm_requests"), 1, "同一 (session_id, request_seq) 只有一行");
  } finally {
    db.close();
    cleanup();
  }
});

test("applyBatch：重复 event_id 不覆盖首次落库的内容", () => {
  const { db, payloadRoot, cleanup } = tempDb();
  try {
    applyBatch(baseBatch(), db, payloadRoot);
    const again: IngestBatch = {
      protocol: PROBE_PROTOCOL_VERSION,
      probe_version: "0.3.0",
      dropped_count: 0,
      queue_depth: 0,
      payload_root: null,
      records: [
        {
          kind: "event",
          event_id: "ev_1",
          session_id: "s1",
          layer: "agent",
          event_type: "agent_start",
          payload_path: null,
          occurred_at: OCCURRED,
          run_seq: 1,
          turn_index: null,
        },
      ],
    };
    applyBatch(again, db, payloadRoot);

    const row = db.prepare("SELECT payload_summary FROM events WHERE event_id = 'ev_1'").get() as {
      payload_summary: string | null;
    };
    // 重复推送不覆盖首次落库的内容：骨架仍是第一次那份
    assert.deepEqual(JSON.parse(row.payload_summary ?? "null"), { runSeq: 1 });
  } finally {
    db.close();
    cleanup();
  }
});

test("applyBatch：写入后按会话广播 SSE", () => {
  const seen: string[] = [];
  const unsubscribe = subscribe((event) => seen.push(event.event));
  try {
    const { db, payloadRoot, cleanup } = tempDb();
    try {
      applyBatch(baseBatch(), db, payloadRoot);
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

test("正文只走文件：记录里带路径，库里只存路径与骨架", () => {
  const { db, payloadRoot, cleanup } = tempDb();
  try {
    // 探针自己把正文写成文件，批次里只带相对路径
    const eventPath = payloadRelPath("event", "s1", "ev_v4");
    const requestPath = payloadRelPath("request", "s1", "1");
    writePayloadFile(payloadRoot, eventPath, JSON.stringify({ runSeq: 1 }));
    writePayloadFile(payloadRoot, requestPath, JSON.stringify({ model: "m" }));

    const parsed = parseBatch({
      protocol: PROBE_PROTOCOL_VERSION,
      probe_version: "0.4.0",
      records: [
        {
          kind: "event",
          event_id: "ev_v4",
          session_id: "s1",
          layer: "agent",
          event_type: "agent_start",
          payload_path: eventPath,
        },
        {
          kind: "request",
          session_id: "s1",
          request_seq: 1,
          payload_path: requestPath,
          payload_bytes: JSON.stringify({ model: "m" }).length,
          created_at: "2026-10-19T10:00:00.000Z",
        },
      ],
    });
    assert.equal(parsed.ok, true, "v4 的批次要能被接受");
    if (!parsed.ok) return;

    applyBatch(parsed.batch, db, payloadRoot);

    const event = db.prepare("SELECT payload_path, payload_summary FROM events WHERE event_id = 'ev_v4'").get() as {
      payload_path: string;
      payload_summary: string;
    };
    assert.equal(event.payload_path, eventPath, "库里存的是相对路径");
    assert.deepEqual(JSON.parse(event.payload_summary), { runSeq: 1 }, "骨架由正文文件生成");

    const request = db.prepare("SELECT payload_path, payload_bytes FROM llm_requests WHERE request_seq = 1").get() as {
      payload_path: string;
      payload_bytes: number;
    };
    assert.equal(request.payload_path, requestPath);
    assert.equal(request.payload_bytes, JSON.stringify({ model: "m" }).length);
  } finally {
    db.close();
    cleanup();
  }
});

test("协议 v3 不再接受：正文必须走文件", () => {
  const result = parseBatch({
    protocol: 3,
    probe_version: "0.3.0",
    records: [{ kind: "session", session_id: "s1" }],
  });
  assert.equal(result.ok, false, "v3 探针应被拒（正文不再随批次传输）");
  if (!result.ok) assert.match(result.error, /协议版本不匹配/);
});

test("兜底建会话行：只有事件没有 session 记录时，会话也会出现", () => {
  const { db, cleanup } = tempDb();
  try {
    const parsed = parseBatch({
      protocol: PROBE_PROTOCOL_VERSION,
      probe_version: "0.4.0",
      records: [
        {
          kind: "event",
          event_id: "ev_orphan",
          session_id: "s-orphan",
          layer: "agent",
          event_type: "agent_start",
          payload_path: null,
        },
      ],
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    applyBatch(parsed.batch, db);

    const session = db.prepare("SELECT session_id, cwd, source FROM sessions WHERE session_id = 's-orphan'").get() as {
      session_id: string;
      cwd: string;
      source: string;
    };
    assert.ok(session, "有事件就该有会话行，否则侧边栏会整个空掉");
    assert.equal(session.cwd, "", "cwd 未知时不编造");
    assert.equal(session.source, "live", "来源如实标成 live");

    // 已存在的会话行不被覆盖
    db.prepare("UPDATE sessions SET cwd = '/tmp/x', source = 'merged' WHERE session_id = 's-orphan'").run();
    applyBatch(parsed.batch, db);
    const after = db.prepare("SELECT cwd, source FROM sessions WHERE session_id = 's-orphan'").get() as {
      cwd: string;
      source: string;
    };
    assert.equal(after.cwd, "/tmp/x", "已有会话行不被兜底逻辑覆盖");
    assert.equal(after.source, "merged");
  } finally {
    db.close();
    cleanup();
  }
});

test("协议版本不对的整批仍然被拒", () => {
  const result = parseBatch({ protocol: 2, records: [{ kind: "session" }] });
  assert.equal(result.ok, false);
});
