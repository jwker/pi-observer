import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareRequestValue, RequestTracker } from "../ext/request.ts";
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

test("请求 payload：先脱敏，payload_bytes 记脱敏前的原始字节数", () => {
  const payload = {
    model: "deepseek-flash",
    authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz",
    headers: { "x-api-key": "plain-secret" },
    messages: [{ role: "user", content: "你好" }],
  };

  const prepared = prepareRequestValue(payload, 512 * 1024);
  assert.equal(prepared.originalBytes, Buffer.byteLength(JSON.stringify(payload), "utf8"));
  assert.equal(prepared.truncated, false);
  assert.deepEqual(prepared.removed.sort(), ["authorization", "headers.x-api-key"]);

  const value = prepared.value as Record<string, unknown>;
  assert.equal(value.authorization, "[redacted]");
  assert.equal((value.headers as Record<string, unknown>)["x-api-key"], "[redacted]");
  assert.deepEqual((value.messages as unknown[]).length, 1);
});

test("请求 payload：超限时给合法 JSON 标记，预览不切坏多字节字符", () => {
  const payload = { model: "m", messages: [{ role: "user", content: "中文".repeat(100_000) }] };
  const prepared = prepareRequestValue(payload, 1000);

  assert.equal(prepared.truncated, true);
  assert.ok(prepared.originalBytes > 1000);
  assert.ok(prepared.storedBytes > 1000);

  const marker = prepared.value as { truncated?: unknown; bytes?: unknown; original_bytes?: unknown; head?: unknown };
  assert.equal(marker.truncated, true);
  assert.equal(marker.bytes, prepared.storedBytes);
  assert.equal(marker.original_bytes, prepared.originalBytes);
  assert.equal(typeof marker.head, "string");
  assert.ok((marker.head as string).includes("已截断"));
  assert.ok(!(marker.head as string).includes("\uFFFD"), "不能出现替换字符");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(prepared.value)));
});

test("请求序号：每次请求自增，重试是一条新记录而不是覆盖", () => {
  const saved: number[] = [];
  const tracker = new RequestTracker({
    sessionId: "s1",
    maxBytes: 512 * 1024,
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
  assert.equal(first.payload_bytes, Buffer.byteLength(JSON.stringify({ model: "m" }), "utf8"));
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
  const tracker = new RequestTracker({ sessionId: "s1", maxBytes: 512 * 1024, now });

  const first = tracker.start({ n: 1 }, meta);
  assert.equal(tracker.pendingCount(), 1);

  // 第一个请求没有响应（用户中断）时，下一次响应不能错记到它头上
  const second = tracker.start({ n: 2 }, meta);
  assert.equal(tracker.pendingCount(), 1);

  const response = tracker.response(200, { authorization: "secret-value", "x-ds-trace-id": "trace-1" });
  assert.equal(response?.request_seq, second.request_seq);
  assert.notEqual(response?.request_seq, first.request_seq);
  assert.equal(response?.payload, null);
  assert.equal(response?.payload_bytes, null);
  assert.equal(response?.payload_truncated, null);
  assert.equal(response?.correlation, "serial_assumed");
  const headers = response?.response_headers as Record<string, unknown>;
  assert.equal(headers.authorization, "[redacted]");
  assert.equal(headers["x-ds-trace-id"], "trace-1");

  assert.equal(tracker.response(500, {}), null, "多出来的响应不凭空造记录");
  assert.equal(tracker.pendingCount(), 0);
});

test("请求 payload 不可序列化时不让 handler 抛错", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const prepared = prepareRequestValue(circular, 1024);
  assert.equal(prepared.truncated, true);
  assert.deepEqual(prepared.value, { unserializable: true, original_bytes: 0 });
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
