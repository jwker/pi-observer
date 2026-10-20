/**
 * 活跃会话每秒同步（R1）：只跟进 `state = 'active'` 的会话，
 * 文件有变化就增量入库并广播；没变化时不重复写。
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backfillFile, createBackfillContext, type BackfillContext } from "../src/lib/backfill.ts";
import { type Db, openDb } from "../src/lib/db.ts";
import { syncActiveSessions } from "../src/lib/session-sync.ts";
import { clearSubscribers, subscribe } from "../src/lib/sse.ts";

const T = (seconds: number) => `2026-10-19T08:00:${String(seconds).padStart(2, "0")}.000Z`;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

interface Fixture {
  db: Db;
  ctx: BackfillContext;
  path: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-sync-"));
  const root = join(dir, "sessions");
  mkdirSync(join(root, "--tmp-proj--"), { recursive: true });
  const path = join(root, "--tmp-proj--", `2026-10-19T08-00-00-000Z_s1.jsonl`);
  writeFileSync(
    path,
    [
      line({ type: "session", version: 3, id: "s1", timestamp: T(0), cwd: "/tmp/proj" }),
      line({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: T(1),
        message: { role: "user", content: [{ type: "text", text: "第一条" }] },
      }),
    ].join(""),
    "utf8",
  );

  const db = openDb(join(dir, "observer.db"));
  const ctx = createBackfillContext({ db, sessionsDir: root, now: () => "2026-10-19T09:00:00.000Z" });
  return {
    db,
    ctx,
    path,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("活跃会话：新追加的条目会在下一拍入库并广播", () => {
  const f = fixture();
  const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
  const unsubscribe = subscribe((event) => seen.push(event));
  try {
    backfillFile(f.path, f.ctx);
    assert.equal(count(f.db, "messages"), 1);
    f.db.prepare("UPDATE sessions SET state = 'active' WHERE session_id = 's1'").run();

    appendFileSync(
      f.path,
      line({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: T(2),
        message: { role: "assistant", content: [{ type: "text", text: "第二条" }], stopReason: "stop" },
      }),
      "utf8",
    );

    const summary = syncActiveSessions(f.ctx);
    assert.deepEqual(
      { sessions: summary.sessions, changed: summary.changed, entries: summary.entries },
      { sessions: 1, changed: 1, entries: 1 },
    );
    assert.equal(count(f.db, "messages"), 2);
    assert.ok(
      seen.some((event) => event.event === "session.updated" && event.data.session_id === "s1"),
      "同步写入后要广播 session.updated",
    );

    // 文件没变：第二拍不再写库、不再广播
    const before = seen.length;
    const again = syncActiveSessions(f.ctx);
    assert.deepEqual(
      { changed: again.changed, entries: again.entries },
      { changed: 0, entries: 0 },
    );
    assert.equal(seen.length, before);
  } finally {
    unsubscribe();
    clearSubscribers();
    f.cleanup();
  }
});

test("非活跃会话：不读文件，等启动扫描或进页面再补", () => {
  const f = fixture();
  try {
    backfillFile(f.path, f.ctx);
    // 回填出来的会话默认是 idle
    appendFileSync(
      f.path,
      line({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: T(2),
        message: { role: "assistant", content: [{ type: "text", text: "不该被这一拍读到" }], stopReason: "stop" },
      }),
      "utf8",
    );

    const summary = syncActiveSessions(f.ctx);
    assert.equal(summary.sessions, 0);
    assert.equal(count(f.db, "messages"), 1);
  } finally {
    f.cleanup();
  }
});
