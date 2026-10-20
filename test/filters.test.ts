/**
 * R3 的纯逻辑：分组筛选存档 + 轮询版本号。
 *
 * 筛选是显示偏好，存坏了必须能安全退回默认；版本号是轮询的判据，
 * 库里可见数据变了它必须变，没变时必须一模一样。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backfillFile, createBackfillContext } from "../src/lib/backfill.ts";
import { type Db, openDb } from "../src/lib/db.ts";
import { DEFAULT_FILTERS, parseFilters, stringifyFilters } from "../src/lib/filters.ts";
import { streamVersion } from "../src/lib/queries.ts";

const T = (ms: number) => new Date(Date.UTC(2026, 9, 19, 8, 0, 0, ms)).toISOString();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function sessionLines(): string[] {
  return [
    line({ type: "session", version: 3, id: "s1", timestamp: T(0), cwd: "/tmp/proj" }),
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
        content: [{ type: "text", text: "好的" }],
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
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-filters-"));
  const root = join(dir, "sessions");
  mkdirSync(join(root, "--tmp-proj--"), { recursive: true });
  const path = join(root, "--tmp-proj--", "2026-10-19T08-00-00-000Z_s1.jsonl");
  writeFileSync(path, sessionLines().join(""), "utf8");

  const db = openDb(join(dir, "observer.db"));
  const ctx = createBackfillContext({ db, sessionsDir: root, now: () => T(9000) });
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

test("筛选存档：没有存档就用默认全开", () => {
  assert.deepEqual(parseFilters(null), DEFAULT_FILTERS);
});

test("筛选存档：存坏了退回默认，不让页面开天窗", () => {
  assert.deepEqual(parseFilters("not json"), DEFAULT_FILTERS);
  assert.deepEqual(parseFilters("[1,2,3]"), DEFAULT_FILTERS);
  assert.deepEqual(parseFilters('{"cats":"x"}'), DEFAULT_FILTERS);
});

test("筛选存档：只认布尔值，缺字段用默认", () => {
  const parsed = parseFilters(
    JSON.stringify({ cats: { tool: false, model: "yes" }, think: false, branch: true }),
  );
  assert.equal(parsed.tool, false);
  assert.equal(parsed.model, true, "非布尔值不当成 false");
  assert.equal(parsed.think, false);
  assert.equal(parsed.branch, true);
  assert.equal(parsed.msg, true);
});

test("筛选存档：写出去再读回来是一样", () => {
  const filters = { ...DEFAULT_FILTERS, tool: false, branch: true };
  assert.deepEqual(parseFilters(stringifyFilters(filters)), filters);
});

test("版本号：库里没变就一模一样；有新条目就必须变", () => {
  const f = fixture();
  try {
    const first = streamVersion("s1", f.db);
    assert.ok(first);
    assert.equal(streamVersion("s1", f.db), first, "没变化时版本号不变");

    f.db
      .prepare(
        `INSERT INTO messages (session_id, entry_id, parent_id, kind, role, timestamp, entry_index, text, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("s1", "u2", "a1", "message", "user", T(5000), 3, "再来一条", "{}");

    const second = streamVersion("s1", f.db);
    assert.ok(second);
    assert.notEqual(second, first, "有新条目时版本号必须变");
  } finally {
    f.cleanup();
  }
});

test("版本号：会话不存在时返回 null", () => {
  const f = fixture();
  try {
    assert.equal(streamVersion("nope", f.db), null);
  } finally {
    f.cleanup();
  }
});
