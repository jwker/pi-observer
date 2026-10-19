import assert from "node:assert/strict";
import test from "node:test";

import { REDACTED, isSensitiveKey, redact, serializeCapped } from "../src/lib/redact.ts";

test("按键名黑名单剔除敏感字段，路径可定位", () => {
  const input = {
    model: "deepseek-v4-pro",
    max_tokens: 4096,
    api_key: "abc",
    messages: [{ role: "user", content: "hi", authorization: "Bearer x" }],
    headers: { "x-api-key": "secret", "content-type": "application/json" },
  };
  const result = redact(input);
  const clone = result.value as Record<string, unknown>;

  assert.equal(clone.api_key, REDACTED);
  assert.equal((clone.headers as Record<string, unknown>)["x-api-key"], REDACTED);
  assert.equal((clone.headers as Record<string, unknown>)["content-type"], "application/json");
  assert.equal(((clone.messages as unknown[])[0] as Record<string, unknown>).authorization, REDACTED);
  assert.ok(result.removed.includes("api_key"));
  assert.ok(result.removed.includes("headers.x-api-key"));
  assert.ok(result.removed.includes("messages[0].authorization"));
});

test("不误伤 max_tokens / tokens 这类正常字段", () => {
  assert.equal(isSensitiveKey("max_tokens"), false);
  assert.equal(isSensitiveKey("tokens"), false);
  assert.equal(isSensitiveKey("input_tokens"), false);
  assert.equal(isSensitiveKey("authorization"), true);
  assert.equal(isSensitiveKey("client_secret"), true);
  assert.equal(isSensitiveKey("ACCESS_TOKEN"), true);
});

test("形如凭据的值即使键名正常也会被替换", () => {
  const result = redact({ note: `sk-abcdefghijklmnopqrstuvwxyz012345`, other: "Bearer abcdefghijklmnopqrst" });
  const clone = result.value as Record<string, string>;
  assert.equal(clone.note, REDACTED);
  assert.equal(clone.other, REDACTED);
});

test("serializeCapped：未超限原样返回，超限给合法 JSON 标记", () => {
  const small = serializeCapped({ a: 1 }, 1024);
  assert.equal(small.truncated, false);
  assert.equal(small.json, '{"a":1}');

  const big = serializeCapped({ text: "x".repeat(1000) }, 100);
  assert.equal(big.truncated, true);
  const parsed = JSON.parse(big.json) as { truncated: boolean; bytes: number };
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.bytes > 100);
});

test("serializeCapped：循环引用不抛异常", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const result = serializeCapped(circular, 1024);
  assert.equal(result.truncated, false);
  assert.ok(result.json.includes("unserializable"));
});
