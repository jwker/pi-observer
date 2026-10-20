/**
 * R4：保留期清理与过期状态自愈。
 *
 * 两件事都是「如实反映事实」而不是猜测：
 *   - 文件还在但超过 7 天 → payload 清空、事件删除，元信息留着；
 *   - 文件已经不在 → 会话不可能还在跑，状态改成「已结束」。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type Db, openDb } from "../src/lib/db.ts";
import { applyRetention } from "../src/lib/retention.ts";
import { endSessionsWithoutFile } from "../src/lib/session-state.ts";

const OLD = "2026-10-01T00:00:00.000Z";
const NEW = "2026-10-19T00:00:00.000Z";
/** 相对「现在」已经 8 天 */
const NOW = new Date("2026-10-19T12:00:00.000Z");

function fixture(): { db: Db; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-retention-"));
  const db = openDb(join(dir, "observer.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedSession(db: Db, id: string, filePath: string | null, state = "active"): void {
  db.prepare(
    `INSERT INTO sessions (session_id, cwd, file_path, state, source, started_at, last_activity_at)
     VALUES (?, '/tmp/p', ?, ?, 'live', ?, ?)`,
  ).run(id, filePath, state, NEW, NEW);
}

test("保留期：过期条目的 payload 被清空，行与元信息留着", () => {
  const f = fixture();
  try {
    f.db
      .prepare(
        `INSERT INTO messages (session_id, entry_id, parent_id, kind, role, timestamp, entry_index, text, payload)
         VALUES ('s1', 'old', NULL, 'message', 'user', ?, 1, '旧消息', '{"a":1}')`,
      )
      .run(OLD);
    f.db
      .prepare(
        `INSERT INTO messages (session_id, entry_id, parent_id, kind, role, timestamp, entry_index, text, payload)
         VALUES ('s1', 'new', NULL, 'message', 'user', ?, 2, '新消息', '{"a":2}')`,
      )
      .run(NEW);

    const outcome = applyRetention(f.db, NOW);
    assert.equal(outcome.messages, 1, "只清空过期的那一条");

    const rows = f.db.prepare("SELECT entry_id, text, payload FROM messages ORDER BY entry_index").all();
    assert.equal(rows.length, 2, "行不会被删");
    assert.equal(rows[0].payload, '{"deleted":true}', "过期条目的 payload 被清空");
    assert.equal(rows[0].text, "旧消息", "摘要留着");
    assert.equal(rows[1].payload, '{"a":2}', "没过期的不动");
  } finally {
    f.cleanup();
  }
});

test("保留期：过期事件整行删除，没过期的留着", () => {
  const f = fixture();
  try {
    const insert = f.db.prepare(
      `INSERT INTO events (event_id, session_id, layer, event_type, payload, occurred_at, received_at)
       VALUES (?, 's1', 'agent', 'agent_settled', '{}', ?, ?)`,
    );
    insert.run("e-old", OLD, OLD);
    insert.run("e-new", NEW, NEW);

    const outcome = applyRetention(f.db, NOW);
    assert.equal(outcome.events, 1, "只删过期的那一条");
    const ids = f.db.prepare("SELECT event_id FROM events").all().map((row) => row.event_id);
    assert.deepEqual(ids, ["e-new"]);
  } finally {
    f.cleanup();
  }
});

test("保留期：过期请求的 payload 与响应头被清空，序号与状态留着", () => {
  const f = fixture();
  try {
    f.db
      .prepare(
        `INSERT INTO llm_requests (session_id, request_seq, provider, api, model, payload, payload_bytes,
                                  payload_truncated, status, response_headers, correlation, created_at)
         VALUES ('s1', 1, 'p', 'a', 'm', '{"x":1}', 100, 0, 200, '{"h":1}', 'serial_assumed', ?)`,
      )
      .run(OLD);

    const outcome = applyRetention(f.db, NOW);
    assert.equal(outcome.requests, 1);

    const row = f.db.prepare("SELECT * FROM llm_requests WHERE request_seq = 1").get() as {
      payload: string;
      response_headers: string;
      status: number;
      model: string;
    };
    assert.equal(row.payload, '{"deleted":true}', "请求体被清空");
    assert.equal(row.response_headers, '{"deleted":true}', "响应头被清空");
    assert.equal(row.status, 200, "状态码留着");
    assert.equal(row.model, "m", "模型留着");
  } finally {
    f.cleanup();
  }
});

test("状态自愈：文件已不存在且仍标着 active 的会话改成 ended", () => {
  const f = fixture();
  try {
    seedSession(f.db, "gone", "/tmp/does-not-exist.jsonl", "active");
    seedSession(f.db, "there", "/tmp/still-here.jsonl", "active");

    const outcome = endSessionsWithoutFile(f.db, {
      exists: (path) => path === "/tmp/still-here.jsonl",
    });
    assert.deepEqual(outcome.ended, ["gone"], "只有文件不在的那个被改");
    assert.deepEqual(outcome.vanished, ["gone"], "文件不在的事实也如实记下来");

    const states = f.db
      .prepare("SELECT session_id, state FROM sessions ORDER BY session_id")
      .all() as Array<{ session_id: string; state: string }>;
    assert.equal(states.find((s) => s.session_id === "gone")?.state, "ended");
    assert.equal(states.find((s) => s.session_id === "there")?.state, "active", "文件还在的不动");
  } finally {
    f.cleanup();
  }
});

test("状态自愈：idle / ended 不动，只有 active 才改", () => {
  const f = fixture();
  try {
    seedSession(f.db, "s-idle", "/tmp/gone-idle.jsonl", "idle");
    seedSession(f.db, "s-ended", "/tmp/gone-ended.jsonl", "ended");
    seedSession(f.db, "s-active", "/tmp/gone-active.jsonl", "active");

    endSessionsWithoutFile(f.db, { exists: () => false });
    const state = (id: string): string =>
      (f.db.prepare("SELECT state FROM sessions WHERE session_id = ?").get(id) as { state: string }).state;
    assert.equal(state("s-idle"), "idle", "idle 是探针明确上报的，不动");
    assert.equal(state("s-ended"), "ended", "已经是 ended 了");
    assert.equal(state("s-active"), "ended");
  } finally {
    f.cleanup();
  }
});

test("状态自愈：没有文件路径的会话不动（无从判断）", () => {
  const f = fixture();
  try {
    seedSession(f.db, "s-nofile", null, "active");
    const outcome = endSessionsWithoutFile(f.db, { exists: () => false });
    assert.deepEqual(outcome.ended, []);
    assert.equal(
      (f.db.prepare("SELECT state FROM sessions WHERE session_id = 's-nofile'").get() as { state: string })
        .state,
      "active",
    );
  } finally {
    f.cleanup();
  }
});
