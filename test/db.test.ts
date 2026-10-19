import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Db, migrate, openDb, withTx } from "../src/lib/db.ts";
import { SCHEMA_VERSION } from "../src/lib/schema.ts";

function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-db-"));
  return {
    path: join(dir, "observer.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function tableNames(db: Db): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

test("建库：9 张表 + user_version + WAL", () => {
  const { path, cleanup } = tempDbPath();
  const db = openDb(path);
  try {
    const tables = tableNames(db).filter((name) => !name.startsWith("sqlite_"));
    assert.deepEqual(tables, [
      "events",
      "jsonl_files",
      "llm_requests",
      "messages",
      "probe_status",
      "runs",
      "sessions",
      "tool_calls",
      "turns",
    ]);

    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, SCHEMA_VERSION);

    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(journal.journal_mode, "wal");
  } finally {
    db.close();
    cleanup();
  }
});

test("索引齐全（PRD §8.5 要求的 6 条 + 本实现补的 2 条）", () => {
  const { path, cleanup } = tempDbPath();
  const db = openDb(path);
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    for (const required of [
      "idx_events_session_time",
      "idx_events_type",
      "idx_turns_session",
      "idx_tools_session",
      "idx_requests_session",
      "idx_sessions_activity",
    ]) {
      assert.ok(names.includes(required), `缺少索引 ${required}`);
    }
  } finally {
    db.close();
    cleanup();
  }
});

test("迁移幂等：重复打开同一个库不报错，版本不变", () => {
  const { path, cleanup } = tempDbPath();
  const first = openDb(path);
  first.close();

  const second = openDb(path);
  try {
    migrate(second);
    const version = second.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, SCHEMA_VERSION);
  } finally {
    second.close();
    cleanup();
  }
});

test("withTx：异常时整体回滚", () => {
  const { path, cleanup } = tempDbPath();
  const db = openDb(path);
  try {
    db.prepare(
      "INSERT INTO sessions (session_id, cwd, started_at, state, source) VALUES ('s1', '/tmp', '2026-01-01T00:00:00Z', 'active', 'live')",
    ).run();

    assert.throws(() => {
      withTx(db, () => {
        db.prepare("UPDATE sessions SET cwd = '/changed' WHERE session_id = 's1'").run();
        throw new Error("boom");
      });
    }, /boom/);

    const row = db.prepare("SELECT cwd FROM sessions WHERE session_id = 's1'").get() as { cwd: string };
    assert.equal(row.cwd, "/tmp");
  } finally {
    db.close();
    cleanup();
  }
});

test("user_version 高于程序支持时拒绝启动", () => {
  const { path, cleanup } = tempDbPath();
  const db = openDb(path);
  try {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    assert.throws(() => migrate(db), /高于本程序支持/);
  } finally {
    db.close();
    cleanup();
  }
});

test("v2 → v3 迁移：给 llm_requests 补 run_seq / turn_index，旧行保留", () => {
  const { path, cleanup } = tempDbPath();
  const old = new Db(path);
  old.exec(`
    CREATE TABLE llm_requests (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id         TEXT NOT NULL,
      request_seq        INTEGER NOT NULL,
      provider           TEXT,
      api                TEXT,
      model              TEXT,
      payload            TEXT,
      payload_bytes      INTEGER NOT NULL DEFAULT 0,
      payload_truncated  INTEGER NOT NULL DEFAULT 0,
      status             INTEGER,
      response_headers   TEXT,
      correlation        TEXT NOT NULL DEFAULT 'serial_assumed',
      created_at         TEXT NOT NULL,
      UNIQUE (session_id, request_seq)
    );
    INSERT INTO llm_requests (session_id, request_seq, created_at)
      VALUES ('old-session', 1, '2026-10-19T00:00:00.000Z');
    PRAGMA user_version = 2;
  `);
  old.close();

  const migrated = openDb(path);
  try {
    const columns = (migrated.prepare("PRAGMA table_info(llm_requests)").all() as Array<{ name: string }>).map(
      (item) => item.name,
    );
    assert.ok(columns.includes("run_seq"), "补上 run_seq");
    assert.ok(columns.includes("turn_index"), "补上 turn_index");
    const row = migrated
      .prepare("SELECT run_seq, turn_index FROM llm_requests WHERE session_id = 'old-session'")
      .get() as { run_seq: number | null; turn_index: number | null };
    assert.equal(row.run_seq, null, "旧行保持 NULL，不编造关联");
    assert.equal(row.turn_index, null);
    const version = migrated.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, SCHEMA_VERSION);
  } finally {
    migrated.close();
    cleanup();
  }
});
