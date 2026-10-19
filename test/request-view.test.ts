import assert from "node:assert/strict";
import test from "node:test";

import { cacheUsage, payloadSections, requestLabel, requestStatusMeta } from "../src/lib/request-view.ts";

test("请求状态：2xx 绿色、4xx 黄色、5xx 红色、null 未响应", () => {
  assert.equal(requestStatusMeta(200).label, "200");
  assert.equal(requestStatusMeta(200).className, "badge ok");
  assert.equal(requestStatusMeta(301).className, "badge info");
  assert.equal(requestStatusMeta(429).className, "badge warn");
  assert.equal(requestStatusMeta(500).className, "badge err");
  assert.equal(requestStatusMeta(null).label, "未响应");
  assert.match(requestStatusMeta(null).title, /还没收到/);
});

test("请求标题：provider / api / model，缺失用破折号", () => {
  assert.equal(requestLabel("deepseek", "openai-completions", "deepseek-flash"), "deepseek / openai-completions / deepseek-flash");
  assert.equal(requestLabel(null, null, null), "— / — / —");
});

test("payload 分段：顶层键各成一段，带字节数、条数与预览", () => {
  const sections = payloadSections({
    model: "m",
    messages: [{ role: "user", content: "你好" }, { role: "assistant", content: "在" }],
    stream: true,
  });

  assert.deepEqual(
    sections.map((section) => section.key),
    ["model", "messages", "stream"],
  );
  const messages = sections[1];
  assert.equal(messages.count, 2);
  assert.ok(messages.bytes > 0);
  assert.match(messages.preview, /"role": "user"/);
  assert.equal(messages.truncated, false);
});

test("payload 分段：超长内容只给预览；截断标记单独成段；空对象也有一段", () => {
  const long = payloadSections({ text: "x".repeat(50) }, 10)[0];
  assert.equal(long.truncated, true);
  assert.ok(long.preview.startsWith('"'));
  assert.match(long.preview, /只显示前 10 个字符/);

  const marker = payloadSections({ truncated: true, bytes: 900_000, original_bytes: 900_000, head: "…" });
  assert.equal(marker.length, 1);
  assert.equal(marker[0].key, "truncated");
  assert.match(marker[0].label, /已截断/);

  const empty = payloadSections({});
  assert.equal(empty.length, 1);
  assert.equal(empty[0].count, 0);

  assert.deepEqual(payloadSections(null), []);
});

test("缓存读数：只认 usage.cacheRead / cacheWrite，缺了不猜", () => {
  assert.deepEqual(cacheUsage({ cacheRead: 12, cacheWrite: 3 }), { read: 12, write: 3 });
  assert.deepEqual(cacheUsage({ input: 1 }), { read: null, write: null });
  assert.deepEqual(cacheUsage(null), { read: null, write: null });
});
