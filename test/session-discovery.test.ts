/**
 * 运行期间发现新会话文件。
 *
 * 背景：服务启动时会全量扫一遍会话目录，但**运行期间新建的会话文件没人发现**——
 * 每秒的同步循环只跟进「库里已经知道、且状态是 active」的会话。
 * 所以一个新目录里开的对话，只有两种情况能出现在看板上：
 *   - 探针在跑，推来了 session_start；
 *   - 服务重启，启动扫描把它捞进来。
 *
 * 探针没装、没跑，或者推不到服务上时，新对话就一直不显示，刷新也没用。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBackfillContext, scanSessionsDir, type BackfillContext } from "../src/lib/backfill.ts";
import { type Db, openDb } from "../src/lib/db.ts";
import { discoverNewSessions } from "../src/lib/session-sync.ts";
import { clearSubscribers, subscribe } from "../src/lib/sse.ts";

const T = (seconds: number) => `2026-10-23T12:00:${String(seconds).padStart(2, "0")}.000Z`;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

interface Fixture {
  db: Db;
  ctx: BackfillContext;
  root: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-discover-"));
  const root = join(dir, "sessions");
  mkdirSync(join(root, "--tmp-proj--"), { recursive: true });

  const db = openDb(join(dir, "observer.db"));
  const ctx = createBackfillContext({ db, sessionsDir: root, now: () => "2026-10-23T13:00:00.000Z" });
  return {
    db,
    ctx,
    root,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 写一个会话文件：头部一行 + 一条用户消息 */
function writeSessionFile(root: string, project: string, id: string, cwd: string): string {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-23T12-46-09-118Z_${id}.jsonl`);
  writeFileSync(
    path,
    [
      line({ type: "session", version: 3, id, timestamp: T(0), cwd }),
      line({
        type: "message",
        id: `${id}-u1`,
        parentId: null,
        timestamp: T(1),
        message: { role: "user", content: [{ type: "text", text: "新目录里开的对话" }] },
      }),
    ].join(""),
    "utf8",
  );
  return path;
}

function sessionExists(db: Db, id: string): boolean {
  return db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(id) !== undefined;
}

test("运行期间新建的会话文件会被发现，不用等服务重启", () => {
  const f = fixture();
  const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
  const unsubscribe = subscribe((event) => seen.push(event));
  try {
    // 启动时扫过一次：此时目录是空的
    scanSessionsDir(f.ctx);
    assert.equal(sessionExists(f.db, "s-new"), false);

    // 运行期间，用户在一个新目录里开了个对话
    writeSessionFile(f.root, "--tmp-new-proj--", "s-new", "/tmp/new-proj");

    const summary = discoverNewSessions(f.ctx);
    assert.equal(summary.discovered, 1, "新文件应该被发现");
    assert.equal(sessionExists(f.db, "s-new"), true, "新会话应该进库");
    assert.ok(
      seen.some((event) => event.event === "session.updated" && event.data.session_id === "s-new"),
      "新会话要广播 session.updated，页面才会自己刷新",
    );
  } finally {
    unsubscribe();
    clearSubscribers();
    f.cleanup();
  }
});

test("已知的会话文件不重复处理", () => {
  const f = fixture();
  try {
    writeSessionFile(f.root, "--tmp-proj--", "s-known", "/tmp/proj");
    scanSessionsDir(f.ctx);
    assert.equal(sessionExists(f.db, "s-known"), true);

    const summary = discoverNewSessions(f.ctx);
    assert.equal(summary.discovered, 0, "已经入库的文件不该再当新的");
    assert.equal(summary.files, 1, "还是要看一眼有几个文件");
  } finally {
    f.cleanup();
  }
});

test("没有新文件时不做任何写入", () => {
  const f = fixture();
  try {
    writeSessionFile(f.root, "--tmp-proj--", "s1", "/tmp/proj");
    scanSessionsDir(f.ctx);
    const before = f.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };

    const summary = discoverNewSessions(f.ctx);
    assert.equal(summary.discovered, 0);
    assert.equal(summary.entries, 0);
    const after = f.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    assert.equal(after.n, before.n);
  } finally {
    f.cleanup();
  }
});
