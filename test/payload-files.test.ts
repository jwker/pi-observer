import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  dirUsage,
  payloadRelPath,
  payloadsRoot,
  readPayloadFile,
  readPayloadJson,
  resolvePayloadPath,
  safeSegment,
  summarizePayload,
  writePayloadFile,
} from "../src/lib/payload-files.ts";

test("路径：会话键安全化，危险字符换成哈希后缀", () => {
  assert.equal(safeSegment("01a16233-708c-740e-b9b3"), "01a16233-708c-740e-b9b3");
  assert.match(safeSegment("session/with:odd*chars"), /^session_with_odd_chars-[0-9a-f]{8}$/);
  // 不同的原值不会撞成同一个文件名
  assert.notEqual(safeSegment("a/b"), safeSegment("a:c"));
});

test("路径：按种类分目录", () => {
  assert.equal(payloadRelPath("request", "s1", "7"), "request/s1/7.json");
  assert.equal(payloadRelPath("event", "s1", "ev_1"), "event/s1/ev_1.json");
  assert.equal(payloadRelPath("message", "s1", "a1"), "message/s1/a1.json");
});

test("路径：不许跑出 payloads 根目录", () => {
  const root = "/tmp/payloads";
  assert.equal(resolvePayloadPath(root, "request/s1/1.json"), join(root, "request/s1/1.json"));
  assert.equal(resolvePayloadPath(root, "../secret.json"), null);
  assert.equal(resolvePayloadPath(root, "request/../../secret.json"), null);
  assert.equal(resolvePayloadPath(root, "/etc/passwd"), null);
  assert.equal(resolvePayloadPath(root, ""), null);
});

test("写入与读取：内容一致，字节数如实", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-pf-"));
  try {
    const root = payloadsRoot(dir);
    const rel = payloadRelPath("request", "s1", "1");
    const bytes = writePayloadFile(root, rel, JSON.stringify({ model: "m", messages: [] }));
    assert.equal(bytes, Buffer.byteLength(JSON.stringify({ model: "m", messages: [] }), "utf8"));
    assert.equal(readPayloadFile(root, rel), JSON.stringify({ model: "m", messages: [] }));
    assert.deepEqual(readPayloadJson(root, rel), { model: "m", messages: [] });
    assert.equal(readPayloadJson(root, "request/s1/9.json"), null, "文件不在时如实返回 null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("写入：临时文件不留痕", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-pf-"));
  try {
    const root = payloadsRoot(dir);
    writePayloadFile(root, "request/s1/1.json", "{}");
    const usage = dirUsage(root);
    assert.equal(usage.files, 1, "只有最终文件，没有残留的临时文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("目录用量：统计字节数与文件数", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-pf-"));
  try {
    const root = payloadsRoot(dir);
    mkdirSync(join(root, "request", "s1"), { recursive: true });
    writeFileSync(join(root, "request", "s1", "1.json"), "x".repeat(100), "utf8");
    writeFileSync(join(root, "request", "s1", "2.json"), "y".repeat(50), "utf8");
    const usage = dirUsage(root);
    assert.equal(usage.files, 2);
    assert.equal(usage.bytes, 150);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("骨架：保留结构，长字符串截短", () => {
  const summary = summarizePayload({
    model: "m",
    messages: [{ role: "user", content: "x".repeat(500) }],
  }) as { model: string; messages: Array<{ role: string; content: string }> };

  assert.equal(summary.model, "m");
  assert.equal(summary.messages[0].role, "user", "结构留着");
  assert.ok(summary.messages[0].content.length < 500, "长字符串被截短");
  assert.ok(summary.messages[0].content.endsWith("…"));
});
