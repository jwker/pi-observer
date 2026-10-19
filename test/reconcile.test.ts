/**
 * M2-5：对账与会话状态推进（PRD §9.3 / §11.1）。
 *
 * 合成会话文件 + 临时看板库，不读真实 `~/.pi/agent/sessions`。
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBackfillContext, type BackfillContext } from "../src/lib/backfill.ts";
import { type Db, openDb } from "../src/lib/db.ts";
import { applyBatch } from "../src/lib/ingest.ts";
import type { EventLayer, IngestRecord } from "../src/lib/protocol.ts";
import {
  RECONCILE_DELAY_MS,
  afterIngest,
  markSessionEnded,
  pendingReconcileCount,
  reconcileSession,
  scheduleReconcile,
  settleSignals,
} from "../src/lib/reconcile.ts";

const T = (seconds: number) => `2026-10-19T08:00:${String(seconds).padStart(2, "0")}.000Z`;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

interface Fixture {
  db: Db;
  ctx: BackfillContext;
  path: string;
  clock: { now: string };
  cleanup: () => void;
}

function sessionLines(): string[] {
  return [
    line({ type: "session", version: 3, id: "s1", timestamp: T(0), cwd: "/tmp/proj" }),
    line({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: T(2),
      message: { role: "user", content: [{ type: "text", text: "看下这个文件" }] },
    }),
    line({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: T(3),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "看完了" }],
        usage: { input: 10, output: 20, cost: { total: 0.01 } },
        stopReason: "stop",
      },
    }),
  ];
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-reconcile-"));
  const root = join(dir, "sessions");
  mkdirSync(join(root, "--tmp-proj--"), { recursive: true });
  const path = join(root, "--tmp-proj--", "2026-10-19T08-00-00-000Z_s1.jsonl");
  writeFileSync(path, sessionLines().join(""), "utf8");

  const db = openDb(join(dir, "observer.db"));
  const clock = { now: "2026-10-19T09:00:00.000Z" };
  const ctx = createBackfillContext({ db, sessionsDir: root, now: () => clock.now });
  return {
    db,
    ctx,
    path,
    clock,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 一条来自探针的会话记录（live），file_path 指向合成文件 */
function liveSessionRecord(filePath: string): IngestRecord {
  return {
    kind: "session",
    session_id: "s1",
    cwd: "/tmp/proj",
    file_path: filePath,
    parent_session: null,
    version: 3,
    name: null,
    started_at: T(0),
    last_activity_at: T(3),
    state: "active",
    source: "live",
  };
}

function eventOf(sessionId: string, layer: EventLayer, eventType: string): IngestRecord {
  return {
    kind: "event",
    event_id: `${sessionId}:${eventType}`,
    session_id: sessionId,
    layer,
    event_type: eventType,
    payload: {},
    occurred_at: T(1),
    run_seq: 1,
    turn_index: 0,
  };
}

/** 取一行（没查到就让测试失败，而不是静默拿到 undefined） */
function row(db: Db, sql: string, ...params: unknown[]): Record<string, unknown> {
  const found = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  assert.ok(found, `没有查到行：${sql}`);
  return { ...found };
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("从一批记录里认出「跑完了」与「关掉了」的会话", () => {
  const records: IngestRecord[] = [
    eventOf("a", "agent", "agent_start"),
    eventOf("a", "agent", "agent_settled"),
    eventOf("a", "turn", "turn_end"),
    eventOf("b", "session", "session_shutdown"),
    eventOf("a", "agent", "agent_settled"), // 同一会话重复出现只算一次
    {
      kind: "session",
      session_id: "c",
      cwd: "",
      file_path: null,
      parent_session: null,
      version: null,
      name: null,
      started_at: null,
      last_activity_at: null,
      state: "idle",
      source: "live",
    },
  ];

  assert.deepEqual(settleSignals(records), { settled: ["a"], shutdown: ["b"] });
  assert.deepEqual(settleSignals([]), { settled: [], shutdown: [] });
  assert.ok(RECONCILE_DELAY_MS >= 1000 && RECONCILE_DELAY_MS <= 10_000);
});

test("对账：读文件、补条目、记 last_reconciled_at，live 变 merged", () => {
  const f = fixture();
  try {
    applyBatch({
      protocol: 2,
      probe_version: "0.1.0",
      dropped_count: 0,
      queue_depth: 0,
      records: [liveSessionRecord(f.path)],
    }, f.db);

    assert.equal(count(f.db, "messages"), 0, "对账之前不该有条目");

    const first = reconcileSession("s1", f.ctx);
    assert.equal(first.found, true);
    assert.equal(first.entries, 2, "头部不算条目：user + assistant");
    assert.equal(first.reconciled_at, "2026-10-19T09:00:00.000Z");
    assert.equal(count(f.db, "messages"), 2);

    const session = row(f.db, "SELECT source, state, last_reconciled_at FROM sessions WHERE session_id = 's1'");
    assert.equal(session.source, "merged", "实时 + 回填都见过 → merged");
    assert.equal(session.state, "active", "对账不动状态，状态归探针管");
    assert.equal(session.last_reconciled_at, "2026-10-19T09:00:00.000Z");

    // 文件没变：只做两次 stat，但仍然算「核对过了」，时间照样更新
    f.clock.now = "2026-10-19T09:05:00.000Z";
    const second = reconcileSession("s1", f.ctx);
    assert.equal(second.entries, 0);
    assert.equal(second.found, true);
    assert.equal(second.reconciled_at, "2026-10-19T09:05:00.000Z");
    assert.equal(
      row(f.db, "SELECT last_reconciled_at FROM sessions WHERE session_id = 's1'").last_reconciled_at,
      "2026-10-19T09:05:00.000Z",
    );

    // 文件没变时 `backfillFile` 会直接跳过、不碰 source：对账自己要把 live 置成 merged
    f.db.prepare("UPDATE sessions SET source = 'live' WHERE session_id = 's1'").run();
    const third = reconcileSession("s1", f.ctx);
    assert.equal(third.entries, 0, "第三次对账文件仍然没变");
    assert.equal(
      row(f.db, "SELECT source FROM sessions WHERE session_id = 's1'").source,
      "merged",
      "没补到新条目也要算对过账",
    );
  } finally {
    f.cleanup();
  }
});

test("对账：只补新增的条目（一遍跑完文件又长了一条）", () => {
  const f = fixture();
  try {
    applyBatch({
      protocol: 2,
      probe_version: "0.1.0",
      dropped_count: 0,
      queue_depth: 0,
      records: [liveSessionRecord(f.path)],
    }, f.db);
    reconcileSession("s1", f.ctx);

    appendFileSync(
      f.path,
      line({
        type: "message",
        id: "a2",
        parentId: "a1",
        timestamp: T(5),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "补充一句" }],
          usage: { input: 3, output: 4, cost: { total: 0.002 } },
          stopReason: "stop",
        },
      }),
      "utf8",
    );

    const again = reconcileSession("s1", f.ctx);
    assert.equal(again.entries, 1, "只读新增的那一条");
    assert.equal(count(f.db, "messages"), 3);
    assert.equal(count(f.db, "turns"), 2, "新助手条目也进 turns");
  } finally {
    f.cleanup();
  }
});

test("对账：没有会话文件时如实返回 found=false，不写核对时间", () => {
  const f = fixture();
  try {
    applyBatch({
      protocol: 2,
      probe_version: "0.1.0",
      dropped_count: 0,
      queue_depth: 0,
      records: [{ ...(liveSessionRecord(f.path) as Extract<IngestRecord, { kind: "session" }>), session_id: "没有文件", file_path: null }],
    }, f.db);

    const outcome = reconcileSession("没有文件", f.ctx);
    assert.equal(outcome.found, false);
    assert.equal(outcome.entries, 0);
    assert.equal(outcome.reconciled_at, null);
    assert.equal(
      row(f.db, "SELECT last_reconciled_at FROM sessions WHERE session_id = '没有文件'").last_reconciled_at,
      null,
    );
  } finally {
    f.cleanup();
  }
});

test("ingest 之后：关闭的会话标 ended，跑完与关闭的都安排对账", () => {
  const f = fixture();
  try {
    applyBatch(
      {
        protocol: 2,
        probe_version: "0.1.0",
        dropped_count: 0,
        queue_depth: 0,
        records: [
          liveSessionRecord(f.path),
          { ...(liveSessionRecord(f.path) as Extract<IngestRecord, { kind: "session" }>), session_id: "s2", file_path: null },
        ],
      },
      f.db,
    );

    const scheduled: string[] = [];
    const result = afterIngest([eventOf("s1", "agent", "agent_settled"), eventOf("s2", "session", "session_shutdown")], {
      db: f.db,
      schedule: (sessionId) => scheduled.push(sessionId),
    });

    assert.deepEqual(result.ended, ["s2"], "只有 shutdown 的会话被标 ended");
    assert.deepEqual(result.scheduled, ["s1", "s2"], "settled 与 shutdown 都要对账");
    assert.deepEqual(scheduled, ["s1", "s2"]);
    assert.equal(row(f.db, "SELECT state FROM sessions WHERE session_id = 's2'").state, "ended");
    assert.equal(row(f.db, "SELECT state FROM sessions WHERE session_id = 's1'").state, "active");

    // 同一个会话在一条批次里同时 settle 与 shutdown：只安排一次对账
    const again: string[] = [];
    const both = afterIngest([eventOf("s1", "agent", "agent_settled"), eventOf("s1", "session", "session_shutdown")], {
      db: f.db,
      schedule: (sessionId) => again.push(sessionId),
    });
    assert.deepEqual(both.ended, ["s1"]);
    assert.deepEqual(both.scheduled, ["s1"]);
    assert.deepEqual(again, ["s1"]);
  } finally {
    f.cleanup();
  }
});

test("安排对账：同一会话只留一个定时器（新的重置计时）", () => {
  scheduleReconcile("dedupe-a", 60_000);
  assert.equal(pendingReconcileCount(), 1);
  scheduleReconcile("dedupe-a", 60_000);
  assert.equal(pendingReconcileCount(), 1, "重复安排不该叠出第二个定时器");
  scheduleReconcile("dedupe-b", 60_000);
  assert.equal(pendingReconcileCount(), 2);
});

test("状态推进：session_shutdown 把会话标成 ended，幂等且不影响别的会话", () => {
  const f = fixture();
  try {
    applyBatch({
      protocol: 2,
      probe_version: "0.1.0",
      dropped_count: 0,
      queue_depth: 0,
      records: [liveSessionRecord(f.path)],
    }, f.db);

    assert.equal(markSessionEnded("s1", f.db), true);
    assert.equal(row(f.db, "SELECT state FROM sessions WHERE session_id = 's1'").state, "ended");

    assert.equal(markSessionEnded("s1", f.db), false, "已经是 ended 就不再算一次改动");
    assert.equal(markSessionEnded("不存在的会话", f.db), false);

    // 对账不会把 ended 改回去
    reconcileSession("s1", f.ctx);
    assert.equal(row(f.db, "SELECT state FROM sessions WHERE session_id = 's1'").state, "ended");
  } finally {
    f.cleanup();
  }
});
