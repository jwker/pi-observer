/**
 * R2 查询：时间线条目、工具引用 / 结果预览、事件详情、整会话取数。
 *
 * 用合成会话文件 + 临时库，不读真实 `~/.pi/agent/sessions`。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backfillFile, createBackfillContext } from "../src/lib/backfill.ts";
import { type Db, openDb } from "../src/lib/db.ts";
import {
  countEvents,
  countTurns,
  getEventDetail,
  listEvents,
  listTimelineMessages,
  listToolCallIndex,
  sessionStreamData,
} from "../src/lib/queries.ts";
import { buildSessionStream } from "../src/lib/stream.ts";

const T = (ms: number) => new Date(Date.UTC(2026, 9, 19, 8, 0, 0, ms)).toISOString();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function sessionLines(): string[] {
  return [
    line({ type: "session", version: 3, id: "s1", timestamp: T(0), cwd: "/tmp/proj" }),
    line({ type: "model_change", id: "m1", timestamp: T(1000), modelId: "deepseek-v4-pro" }),
    // 真实会话里的系统消息 content 是空串；json_each 不能直接吃它，查询要跳过
    line({
      type: "message",
      id: "s1",
      parentId: "m1",
      timestamp: T(2000),
      message: {
        role: "system",
        content: "",
        sections: { preamble: "You are an expert coding assistant." },
      },
    }),
    line({
      type: "message",
      id: "u1",
      parentId: "s1",
      timestamp: T(3000),
      message: { role: "user", content: [{ type: "text", text: "看下这个文件" }] },
    }),
    line({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: T(4000),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先读文件" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/proj/x.ts" } },
        ],
        stopReason: "toolUse",
      },
    }),
    line({
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: T(5000),
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "文件内容" }],
        isError: false,
        durationMs: 12,
      },
    }),
    line({
      type: "message",
      id: "a2",
      parentId: "t1",
      timestamp: T(6000),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "这个文件是入口" }],
        stopReason: "stop",
      },
    }),
  ];
}

interface Fixture {
  db: Db;
  path: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-stream-"));
  const root = join(dir, "sessions");
  mkdirSync(join(root, "--tmp-proj--"), { recursive: true });
  const path = join(root, "--tmp-proj--", `2026-10-19T08-00-00-000Z_s1.jsonl`);
  writeFileSync(path, sessionLines().join(""), "utf8");

  const db = openDb(join(dir, "observer.db"));
  const ctx = createBackfillContext({
    db,
    sessionsDir: root,
    now: () => T(9000),
  });
  backfillFile(path, ctx);

  return {
    db,
    path,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("listTimelineMessages：正文 / 思考 / 空系统消息都不报错", () => {
  const f = fixture();
  try {
    const messages = listTimelineMessages("s1", 100, f.db);
    assert.equal(messages.length, 6);
    assert.deepEqual(
      messages.map((message) => message.entry_id),
      ["m1", "s1", "u1", "a1", "t1", "a2"],
    );

    const system = messages.find((message) => message.entry_id === "s1");
    assert.ok(system);
    assert.match(system.text ?? "", /^\[系统提示\]/);

    const assistant = messages.find((message) => message.entry_id === "a1");
    assert.ok(assistant);
    assert.equal(assistant.thinking, "先读文件");
    assert.equal(assistant.text, "[思考] [工具调用：read]");
    assert.ok(assistant.payload_bytes > 0);

    const final = messages.find((message) => message.entry_id === "a2");
    assert.ok(final);
    assert.equal(final.text, "这个文件是入口");
    assert.equal(final.thinking, null);
  } finally {
    f.cleanup();
  }
});

test("工具索引带条目引用与结果预览；详情仍然有完整参数 / 结果", () => {
  const f = fixture();
  try {
    const index = listToolCallIndex("s1", 10, f.db);
    assert.equal(index.length, 1);
    const tool = index[0];
    assert.ok(tool);
    assert.equal(tool.entry_id, "a1");
    assert.equal(tool.result_entry_id, "t1");
    assert.match(tool.args_preview ?? "", /x\.ts/);
    assert.equal(tool.result_preview, "文件内容");
    assert.ok(tool.args_bytes > 0);
    assert.ok(tool.result_bytes > 0);
  } finally {
    f.cleanup();
  }
});

test("listEvents：时间线可以按 id 倒序取最近事件", () => {
  const f = fixture();
  try {
    const insert = f.db.prepare(
      `INSERT INTO events (event_id, session_id, layer, event_type, run_seq, turn_index, payload, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("e1", "s1", "session", "session_start", null, null, "{}", T(0), T(0));
    insert.run("e2", "s1", "agent", "agent_settled", null, null, "{}", T(7000), T(7000));

    assert.deepEqual(
      listEvents("s1", { order: "desc", limit: 1 }, f.db).map((event) => event.event_id),
      ["e2"],
    );
    assert.deepEqual(
      listEvents("s1", { limit: 2 }, f.db).map((event) => event.event_id),
      ["e1", "e2"],
      "默认仍是升序，不影响实时增量拉取",
    );
  } finally {
    f.cleanup();
  }
});

test("sessionStreamData：一次取全 + totals；getEventDetail 解析 payload", () => {
  const f = fixture();
  try {
    f.db
      .prepare(
        `INSERT INTO events (event_id, session_id, layer, event_type, run_seq, turn_index, payload, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "e1",
        "s1",
        "session",
        "session_start",
        null,
        null,
        JSON.stringify({ reason: "startup" }),
        T(0),
        T(0),
      );

    assert.equal(countTurns("s1", f.db), 2);
    assert.equal(countEvents("s1", f.db), 1);

    const data = sessionStreamData("s1", f.db);
    assert.ok(data);
    assert.equal(data.session.session_id, "s1");
    assert.equal(data.messages.length, 6);
    assert.equal(data.turns.length, 2);
    assert.equal(data.tools.length, 1);
    assert.equal(data.events.length, 1);
    assert.deepEqual(data.totals, { messages: 6, turns: 2, events: 1, tools: 1, requests: 0 });

    const stream = buildSessionStream(data);
    assert.equal(stream.turns.length, 1);
    assert.equal(stream.turns[0]?.summary, "看下这个文件");
    assert.equal(stream.turns[0]?.rows.some((row) => row.kind === "tool"), true);
    assert.equal(stream.prelude?.rows.some((row) => row.kind === "system"), true);

    const event = getEventDetail("s1", "e1", f.db);
    assert.ok(event);
    assert.equal(event.event_type, "session_start");
    assert.deepEqual(event.payload, { reason: "startup" });
    assert.equal(getEventDetail("s1", "missing", f.db), null);
  } finally {
    f.cleanup();
  }
});
