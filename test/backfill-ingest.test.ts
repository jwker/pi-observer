/**
 * M2-2：会话文件回填入库的判据（PRD §9.1 / §9.2 / §9.3）。
 *
 * 全部用合成会话文件 + 临时看板库，不读真实 `~/.pi/agent/sessions`。
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  backfillFile,
  createBackfillContext,
  createJournalReader,
  ensureSessionBackfilled,
  scanSessionsDir,
  type BackfillContext,
} from "../src/lib/backfill.ts";
import { type Db, openDb } from "../src/lib/db.ts";
import { applyBatch } from "../src/lib/ingest.ts";

const T = (seconds: number) => `2026-10-19T08:00:${String(seconds).padStart(2, "0")}.000Z`;

interface Fixture {
  db: Db;
  root: string;
  ctx: BackfillContext;
  path: string;
  cleanup: () => void;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** 一段典型的会话：头部 + 改模型 + 用户提问 + 助手调工具 + 工具结果 + 助手收尾 */
function sessionLines(sessionId = "s1", cwd = "/tmp/proj"): string[] {
  return [
    line({ type: "session", version: 3, id: sessionId, timestamp: T(0), cwd }),
    line({ type: "model_change", id: "m1", timestamp: T(1), modelId: "deepseek-v4-pro" }),
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
        content: [
          { type: "thinking", thinking: "先读文件" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/proj/x.ts" } },
        ],
        provider: "deepseek",
        model: "deepseek-v4-pro",
        usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: { total: 0.01 } },
        stopReason: "toolUse",
        thinkingLevel: "medium",
      },
    }),
    line({
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: T(4),
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
      timestamp: T(5),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "这个文件是入口" }],
        usage: { input: 200, output: 50, cost: { total: 0.02 } },
        stopReason: "stop",
      },
    }),
  ];
}

function fixture(options: { lines?: string[]; sessionId?: string; mtime?: number } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-backfill-"));
  const root = join(dir, "sessions");
  mkdirSync(join(root, "--tmp-proj--"), { recursive: true });
  const sessionId = options.sessionId ?? "s1";
  const path = join(root, "--tmp-proj--", `2026-10-19T08-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(path, (options.lines ?? sessionLines(sessionId)).join(""), "utf8");

  const db = openDb(join(dir, "observer.db"));
  const ctx = createBackfillContext({
    db,
    sessionsDir: root,
    now: () => "2026-10-19T09:00:00.000Z",
  });
  return {
    db,
    root,
    ctx,
    path,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function row(db: Db, sql: string, ...params: unknown[]): Record<string, unknown> {
  const found = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  assert.ok(found, `没有查到行：${sql}`);
  return { ...found };
}

function rows(db: Db, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return (db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>).map((item) => ({ ...item }));
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("backfillFile：会话 / 条目 / turn / 工具调用全部落库，字段与文件一致", () => {
  const f = fixture();
  try {
    const result = backfillFile(f.path, f.ctx);
    assert.equal(result.skipped, false);
    assert.equal(result.sessionId, "s1");
    assert.equal(result.entries, 5);
    assert.deepEqual(result.warnings, []);

    const session = row(f.db, "SELECT * FROM sessions WHERE session_id = 's1'");
    assert.equal(session.cwd, "/tmp/proj");
    assert.equal(session.file_path, f.path);
    assert.equal(session.version, 3);
    assert.equal(session.started_at, T(0));
    assert.equal(session.state, "idle");
    assert.equal(session.source, "backfill");
    assert.equal(session.message_count, 4); // u1 / a1 / t1 / a2
    assert.equal(session.turn_count, 2);
    assert.equal(session.tool_call_count, 1);
    assert.equal(session.tokens_in, 300);
    assert.equal(session.tokens_out, 70);
    assert.equal(session.cache_read, 30);
    assert.equal(session.cache_write, 5);
    assert.ok(Math.abs((session.cost as number) - 0.03) < 1e-9);
    assert.equal(session.last_activity_at, T(5));

    // 每条 JSONL 条目一行，kind 原样保留
    assert.deepEqual(
      rows(f.db, "SELECT entry_id, kind, role, entry_index FROM messages WHERE session_id = 's1' ORDER BY entry_index")
        .map((m) => [m.entry_id, m.kind, m.role, m.entry_index]),
      [
        ["m1", "model_change", null, 2],
        ["u1", "message", "user", 3],
        ["a1", "message", "assistant", 4],
        ["t1", "message", "toolResult", 5],
        ["a2", "message", "assistant", 6],
      ],
    );

    // 摘要：message 是正文，非 message 是一行说明；正文里没有 text 部分时给占位
    const texts = Object.fromEntries(
      rows(f.db, "SELECT entry_id, text FROM messages WHERE session_id = 's1'").map((m) => [m.entry_id, m.text]),
    );
    assert.equal(texts.u1, "看下这个文件");
    assert.equal(texts.a1, "[思考] [工具调用：read]");
    assert.equal(texts.t1, "文件内容");
    assert.equal(texts.m1, "模型 → deepseek-v4-pro");

    // payload 是原始条目 JSON（未截断时逐字节等价）
    const payload = row(f.db, "SELECT payload FROM messages WHERE session_id = 's1' AND entry_id = 'a1'");
    assert.deepEqual(JSON.parse(payload.payload as string), JSON.parse(sessionLines()[3]));

    // turn：持久键是助手条目 id；run_seq 是回填的占位值 1
    const turns = rows(f.db, "SELECT * FROM turns WHERE session_id = 's1' ORDER BY turn_index");
    assert.equal(turns.length, 2);
    assert.deepEqual(
      turns.map((t) => [t.message_entry_id, t.run_seq, t.turn_index]),
      [
        ["a1", 1, 0],
        ["a2", 1, 1],
      ],
    );
    assert.equal(turns[0].stop_reason, "toolUse");
    assert.equal(turns[0].thinking_level, "medium");
    assert.equal(turns[0].tokens_in, 100);
    assert.equal(turns[0].tokens_out, 20);
    assert.equal(turns[0].started_at, T(2)); // 上一条（用户消息）的时间
    assert.equal(turns[0].ended_at, T(4)); // 工具结果的时间
    assert.deepEqual(JSON.parse(turns[0].tool_results as string), [{ toolCallId: "call_1", isError: false }]);
    assert.equal(turns[1].stop_reason, "stop");
    assert.equal(turns[1].started_at, T(4));
    assert.equal(turns[1].ended_at, T(5));

    // 工具调用：调用参数与结果分别来自助手条目与工具结果条目
    const tool = row(f.db, "SELECT * FROM tool_calls WHERE tool_call_id = 'call_1'");
    assert.equal(tool.session_id, "s1");
    assert.equal(tool.tool_name, "read");
    assert.deepEqual(JSON.parse(tool.args as string), { path: "/tmp/proj/x.ts" });
    assert.equal(tool.is_error, 0);
    assert.equal(tool.duration_ms, 12);
    assert.equal(tool.started_at, T(3));
    assert.equal(tool.ended_at, T(4));
    const toolResult = JSON.parse(tool.result as string) as { toolCallId: string; content: unknown };
    assert.equal(toolResult.toolCallId, "call_1");
    assert.deepEqual(toolResult.content, [{ type: "text", text: "文件内容" }]);

    // 读取进度
    const file = row(f.db, "SELECT * FROM jsonl_files WHERE path = ?", f.path);
    assert.equal(file.session_id, "s1");
    assert.equal(file.entry_count, 5);
    assert.equal(file.last_read_at, "2026-10-19T09:00:00.000Z");
  } finally {
    f.cleanup();
  }
});

test("backfillFile：文件没变则跳过，不重读也不重复写", () => {
  const f = fixture();
  try {
    backfillFile(f.path, f.ctx);
    const again = backfillFile(f.path, f.ctx);
    assert.equal(again.skipped, true);
    assert.equal(again.sessionId, "s1");
    assert.equal(again.entries, 0);
    assert.equal(count(f.db, "messages"), 5);
    assert.equal(count(f.db, "turns"), 2);
  } finally {
    f.cleanup();
  }
});

test("backfillFile：追加内容后只补新条目，旧行不受影响", () => {
  const f = fixture();
  try {
    backfillFile(f.path, f.ctx);
    appendFileSync(
      f.path,
      line({
        type: "message",
        id: "u2",
        parentId: "a2",
        timestamp: T(6),
        message: { role: "user", content: [{ type: "text", text: "继续" }] },
      }),
      "utf8",
    );

    const result = backfillFile(f.path, f.ctx);
    assert.equal(result.skipped, false);
    assert.equal(result.entries, 1);
    assert.equal(count(f.db, "messages"), 6);
    assert.equal(row(f.db, "SELECT message_count FROM sessions WHERE session_id = 's1'").message_count, 5);
    assert.equal(row(f.db, "SELECT last_activity_at FROM sessions WHERE session_id = 's1'").last_activity_at, T(6));
  } finally {
    f.cleanup();
  }
});

test("backfillFile：换一个新的补读上下文（同一个文件系统）只消费新增的字节", () => {
  const f = fixture();
  try {
    backfillFile(f.path, f.ctx);
    appendFileSync(
      f.path,
      line({
        type: "message",
        id: "u2",
        parentId: "a2",
        timestamp: T(6),
        message: { role: "user", content: [{ type: "text", text: "继续" }] },
      }),
      "utf8",
    );
    // 模拟「进页面时新建的上下文」：读取器是按文件系统共享的，所以只读尾部
    const fresh = createBackfillContext({ db: f.db, sessionsDir: f.root });
    const result = backfillFile(f.path, fresh);
    assert.equal(result.entries, 1);
    assert.equal(count(f.db, "messages"), 6);
  } finally {
    f.cleanup();
  }
});

test("backfillFile：整文件重写不产生重复行，且 entry_index 被修正", () => {
  const f = fixture();
  try {
    backfillFile(f.path, f.ctx);
    assert.equal(count(f.db, "turns"), 2);

    // 重写：加一条插入到中间的条目（大小变大，但内容顺序变了）
    const rewritten = [...sessionLines()];
    rewritten.splice(2, 0, line({ type: "thinking_level_change", id: "h1", timestamp: T(1), thinkingLevel: "high" }));
    writeFileSync(f.path, rewritten.join(""), "utf8");

    const result = backfillFile(f.path, f.ctx);
    assert.equal(result.skipped, false);
    assert.equal(count(f.db, "messages"), 6);
    assert.equal(count(f.db, "turns"), 2); // 助手条目 id 没变，turn 不重复
    assert.equal(count(f.db, "tool_calls"), 1);

    // 行号变了：新条目插在头部之后，后续条目的 entry_index 顺延一位
    assert.deepEqual(
      rows(f.db, "SELECT entry_id, entry_index FROM messages WHERE session_id = 's1' ORDER BY entry_index").map((m) => [
        m.entry_id,
        m.entry_index,
      ]),
      [
        ["m1", 2],
        ["h1", 3],
        ["u1", 4],
        ["a1", 5],
        ["t1", 6],
        ["a2", 7],
      ],
    );
  } finally {
    f.cleanup();
  }
});

test("backfillFile：坏行跳过并记警告，其余条目照常入库", () => {
  const f = fixture();
  try {
    writeFileSync(f.path, [...sessionLines().slice(0, 3), "这不是 JSON\n", ...sessionLines().slice(3)].join(""), "utf8");
    const warnings: string[] = [];
    const f2 = { ...f, ctx: createBackfillContext({ ...f.ctx, onWarning: (m) => warnings.push(m) }) };
    const result = backfillFile(f.path, f2.ctx);

    assert.equal(result.entries, 5);
    assert.equal(count(f.db, "messages"), 5);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /不是合法 JSON/);
  } finally {
    f.cleanup();
  }
});

test("backfillFile：没有 id 的条目用行号当键，重复回填仍然幂等", () => {
  const f = fixture({
    lines: [
      line({ type: "session", version: 3, id: "s1", timestamp: T(0), cwd: "/tmp/proj" }),
      line({ type: "custom", timestamp: T(1), text: "没有 id 的自定义条目" }),
    ],
  });
  try {
    const first = backfillFile(f.path, f.ctx);
    assert.equal(first.entries, 1);
    assert.equal(first.sessionId, "s1");
    const stored = row(f.db, "SELECT entry_id, kind, text FROM messages WHERE session_id = 's1'");
    assert.equal(stored.entry_id, "#line:2");
    assert.equal(stored.kind, "custom");
    assert.equal(stored.text, "没有 id 的自定义条目");

    // 追加一条（文件变了，会真的重读一次）：没有 id 的旧条目仍然只有一行
    appendFileSync(f.path, line({ type: "custom", timestamp: T(2), text: "第二条" }), "utf8");
    backfillFile(f.path, f.ctx);
    assert.equal(count(f.db, "messages"), 2);
    assert.equal(row(f.db, "SELECT COUNT(*) AS n FROM messages WHERE entry_id = '#line:2'").n, 1);
  } finally {
    f.cleanup();
  }
});

test("backfillFile：实时先写过 turn 时，回填落同一行且不动 run_seq / turn_index / state", () => {
  const f = fixture();
  try {
    // 先按实时路径写同一批：会话 + 助手 turn（同一个 message_entry_id）
    applyBatch(
      {
        protocol: 1,
        probe_version: "0.1.0",
        dropped_count: 0,
        queue_depth: 0,
        records: [
          {
            kind: "session",
            session_id: "s1",
            cwd: "/tmp/proj",
            file_path: f.path,
            parent_session: null,
            version: 3,
            name: "实时的名字",
            started_at: T(0),
            last_activity_at: T(3),
            state: "active",
            source: "live",
          },
          {
            kind: "turn",
            session_id: "s1",
            run_seq: 7,
            turn_index: 3,
            message_entry_id: "a1",
            started_at: T(2),
            ended_at: T(3),
            stop_reason: "toolUse",
            thinking_level: "medium",
            assistant_message: { role: "assistant" },
            tool_results: [],
            tokens_in: null,
            tokens_out: null,
            cost: null,
          },
        ],
      },
      f.db,
    );

    backfillFile(f.path, f.ctx);

    const turn = row(f.db, "SELECT * FROM turns WHERE message_entry_id = 'a1'");
    assert.equal(turn.run_seq, 7); // 实时观察到的值，回填不覆盖
    assert.equal(turn.turn_index, 3);
    assert.equal(turn.tokens_in, 100); // 文件里有的值补上来
    assert.equal(turn.cost, 0.01);
    assert.equal(count(f.db, "turns"), 2); // a1 不重复

    const session = row(f.db, "SELECT state, source, name FROM sessions WHERE session_id = 's1'");
    assert.equal(session.state, "active"); // 回填不推进状态
    assert.equal(session.source, "merged"); // 实时 + 回填 = merged（PRD §9.3）
    assert.equal(session.name, "实时的名字"); // 回填不写 name
  } finally {
    f.cleanup();
  }
});

test("backfillFile：重写后还没读到头部时不写库（不知道算谁的）", () => {
  const f = fixture();
  try {
    backfillFile(f.path, f.ctx);
    // 重写成同一个会话，但把头部那行去掉并夹在很长的填充后面，模拟头部还没读到
    const rest = sessionLines().slice(1).join("");
    writeFileSync(f.path, `${rest}`, "utf8");
    const before = count(f.db, "messages");

    const result = backfillFile(f.path, f.ctx);
    assert.equal(result.sessionId, null);
    assert.equal(result.entries, 0);
    assert.equal(count(f.db, "messages"), before);
    assert.match(result.warnings.join("\n"), /还没读到会话头部/);
  } finally {
    f.cleanup();
  }
});

test("scanSessionsDir：扫到的文件全部入库，未变的文件跳过", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "--tmp-other--"), { recursive: true });
    const other = join(f.root, "--tmp-other--", "2026-10-19T08-10-00-000Z_s2.jsonl");
    writeFileSync(other, sessionLines("s2", "/tmp/other").join(""), "utf8");

    const first = scanSessionsDir(f.ctx);
    assert.equal(first.files, 2);
    assert.equal(first.skipped, 0);
    assert.equal(first.changed, 2);
    assert.equal(first.entries, 10);
    assert.deepEqual(first.sessionIds.sort(), ["s1", "s2"]);
    assert.deepEqual(first.warnings, []);
    assert.equal(count(f.db, "sessions"), 2);

    const second = scanSessionsDir(f.ctx);
    assert.equal(second.files, 2);
    assert.equal(second.skipped, 2);
    assert.equal(second.entries, 0);
  } finally {
    f.cleanup();
  }
});

test("scanSessionsDir：目录不存在只记警告，不抛异常", () => {
  const f = fixture();
  try {
    const result = scanSessionsDir(createBackfillContext({ ...f.ctx, sessionsDir: join(f.root, "没有这个目录") }));
    assert.equal(result.files, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /读不到会话目录/);
  } finally {
    f.cleanup();
  }
});

test("ensureSessionBackfilled：库里没有 file_path 时按文件名找到会话文件", () => {
  const f = fixture();
  try {
    // 先只写一条没有 file_path 的实时会话行
    f.db
      .prepare("INSERT INTO sessions (session_id, cwd, state, source) VALUES ('s1', '/tmp/proj', 'idle', 'live')")
      .run();

    const result = ensureSessionBackfilled("s1", f.ctx);
    assert.ok(result);
    assert.equal(result.sessionId, "s1");
    assert.equal(result.entries, 5);
    assert.equal(row(f.db, "SELECT source FROM sessions WHERE session_id = 's1'").source, "merged");
    assert.equal(count(f.db, "messages"), 5);

    // 再进一次页面：文件没变 → 跳过
    const again = ensureSessionBackfilled("s1", f.ctx);
    assert.equal(again?.skipped, true);

    // 找不到的会话返回 null
    assert.equal(ensureSessionBackfilled("没有这个会话", f.ctx), null);
  } finally {
    f.cleanup();
  }
});

test("createJournalReader：重写时默认按 id 去重，emitAll 让全部条目重新产出", () => {
  const f = fixture();
  try {
    const reader = createJournalReader();
    const first = reader.read(f.path);
    assert.equal(first.entries.length, 5);
    assert.equal(first.sessionId, "s1");

    // 没有新字节：本次没有条目，但会话 id 还记得（增量读也要能拿到）
    const incremental = reader.read(f.path);
    assert.equal(incremental.entries.length, 0);
    assert.equal(incremental.sessionId, "s1");

    // 整文件重写（变小）：重读到了旧条目，但规则 3 会按 id 全部过滤掉
    writeFileSync(f.path, sessionLines().slice(0, 4).join(""), "utf8");
    const deduped = reader.read(f.path);
    assert.equal(deduped.restarted, true);
    assert.equal(deduped.entries.length, 0);

    // 再重写一次：emitAll 把重读到的条目全部产出（回填靠它修正 entry_index）
    writeFileSync(f.path, sessionLines().slice(0, 3).join(""), "utf8");
    const all = reader.read(f.path, { emitAll: true });
    assert.equal(all.restarted, true);
    assert.equal(all.sessionId, "s1");
    assert.deepEqual(
      all.entries.map((entry) => entry.lineNo),
      [2, 3],
    );
  } finally {
    f.cleanup();
  }
});

test("messages.payload 超过上限时截断并打标（不写半截 JSON）", () => {
  const f = fixture();
  try {
    const ctx = createBackfillContext({ ...f.ctx, payloadMaxBytes: 200 });
    writeFileSync(
      f.path,
      [
        line({ type: "session", version: 3, id: "s1", timestamp: T(0), cwd: "/tmp/proj" }),
        line({ type: "message", id: "u1", parentId: null, timestamp: T(1), message: { role: "user", content: "x".repeat(2000) } }),
      ].join(""),
      "utf8",
    );
    backfillFile(f.path, ctx);

    const stored = row(f.db, "SELECT payload FROM messages WHERE session_id = 's1' AND entry_id = 'u1'");
    const parsed = JSON.parse(stored.payload as string) as { truncated?: boolean; bytes?: number };
    assert.equal(parsed.truncated, true);
    assert.ok((parsed.bytes ?? 0) > 200);
  } finally {
    f.cleanup();
  }
});
