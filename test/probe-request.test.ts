import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RequestTracker, serializePayload } from "../ext/request.ts";
import { createPayloadStore } from "../ext/payload-store.ts";
import { sessionCursorStore } from "../ext/session-cursor.ts";

const NOW = "2026-10-19T10:00:00.000Z";
const now = () => NOW;
const meta = {
  provider: "deepseek",
  api: "openai-completions",
  model: "deepseek-flash",
  runSeq: 2,
  turnIndex: 5,
};

test("请求 payload：写进文件，批次里只带路径与字节数", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-observer-payload-"));
  try {
    const store = createPayloadStore({ root });
    const payload = {
      model: "deepseek-flash",
      messages: [{ role: "user", content: "你好" }],
    };
    const tracker = new RequestTracker({ sessionId: "s1", store, now });
    const record = tracker.start(payload, meta);

    assert.equal(record.payload_path, "request/s1/1.json");
    assert.equal(record.payload_bytes, Buffer.byteLength(JSON.stringify(payload), "utf8"));

    const written = JSON.parse(readFileSync(join(root, "request", "s1", "1.json"), "utf8"));
    assert.equal(written.model, "deepseek-flash", "文件里是完整正文");
    assert.equal(written.messages.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("请求 payload 不可序列化时不让 handler 抛错", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const text = serializePayload(circular);
  assert.deepEqual(JSON.parse(text), { unserializable: true });
});

test("请求序号：每次请求自增，重试是一条新记录而不是覆盖", () => {
  const saved: number[] = [];
  const tracker = new RequestTracker({
    sessionId: "s1",
    initialSeq: 4,
    persistSeq: (seq) => saved.push(seq),
    now,
  });

  const first = tracker.start({ model: "m" }, meta);
  assert.equal(first.request_seq, 5);
  assert.equal(first.provider, "deepseek");
  assert.equal(first.api, "openai-completions");
  assert.equal(first.model, "deepseek-flash");
  assert.equal(first.run_seq, 2, "请求关联到发起它的运行");
  assert.equal(first.turn_index, 5, "请求关联到发起它的 Turn");
  assert.equal(first.payload_path, null, "没有 store 时没有正文文件");
  assert.equal(first.payload_bytes, null);
  assert.equal(first.status, null);
  assert.deepEqual(saved, [5]);

  // 429 也是一次完整响应；重试会再发一次 before_provider_request
  const retryResponse = tracker.response(429, { "retry-after": "1" });
  assert.equal(retryResponse?.request_seq, 5);
  assert.equal(retryResponse?.status, 429);

  const second = tracker.start({ model: "m", attempt: 2 }, meta);
  assert.equal(second.request_seq, 6);
  assert.equal(tracker.response(200, {})?.request_seq, 6);
  assert.deepEqual(saved, [5, 6]);
  assert.equal(tracker.pendingCount(), 0);
});

test("请求与响应：串行配对；新的请求会放弃未响应的旧请求", () => {
  const tracker = new RequestTracker({ sessionId: "s1", now });

  const first = tracker.start({ n: 1 }, meta);
  assert.equal(tracker.pendingCount(), 1);

  // 第一个请求没有响应（用户中断）时，下一次响应不能错记到它头上
  const second = tracker.start({ n: 2 }, meta);
  assert.equal(tracker.pendingCount(), 1);

  const response = tracker.response(200, { authorization: "secret-value", "x-ds-trace-id": "trace-1" });
  assert.equal(response?.request_seq, second.request_seq);
  assert.notEqual(response?.request_seq, first.request_seq);
  assert.equal(response?.payload_path, null);
  assert.equal(response?.payload_bytes, null);
  assert.equal(response?.correlation, "serial_assumed");
  const headers = response?.response_headers as Record<string, unknown>;
  assert.equal(headers.authorization, "secret-value", "不再脱敏");
  assert.equal(headers["x-ds-trace-id"], "trace-1");

  assert.equal(tracker.response(500, {}), null, "多出来的响应不凭空造记录");
  assert.equal(tracker.pendingCount(), 0);
});

test("会话游标：request_seq 与 run_seq 跨实例继续，文件权限 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-cursor-"));
  try {
    const tokenFile = join(dir, "token");
    const sessionId = "session/with:odd*chars";
    const store = sessionCursorStore(tokenFile, sessionId);
    assert.deepEqual(store.load(), { requestSeq: 0, runSeq: 0 }, "首次没有游标");

    store.save({ requestSeq: 7, runSeq: 3 });
    assert.deepEqual(store.load(), { requestSeq: 7, runSeq: 3 });
    assert.equal(statSync(store.file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(store.file, "utf8")), { requestSeq: 7, runSeq: 3 });

    assert.deepEqual(sessionCursorStore(tokenFile, sessionId).load(), { requestSeq: 7, runSeq: 3 }, "新实例接着用");
    assert.deepEqual(sessionCursorStore(tokenFile, "another-session").load(), { requestSeq: 0, runSeq: 0 }, "不同会话互不影响");

    // 兼容旧的 request-seq/<hash>.seq：只有 request_seq，run_seq 从 0 开始
    const legacyId = "legacy-session";
    const legacyKey = createHash("sha256").update(legacyId).digest("hex").slice(0, 32);
    mkdirSync(join(dir, "request-seq"), { recursive: true });
    writeFileSync(join(dir, "request-seq", `${legacyKey}.seq`), "5\n", "utf8");
    assert.deepEqual(sessionCursorStore(tokenFile, legacyId).load(), { requestSeq: 5, runSeq: 0 });

    writeFileSync(store.file, "not-json", "utf8");
    assert.deepEqual(store.load(), { requestSeq: 0, runSeq: 0 }, "坏文件按 0 处理，不抛错");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
