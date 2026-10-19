import assert from "node:assert/strict";
import test from "node:test";

import { ensureToken, tokensMatch } from "../src/lib/auth.ts";
import { readBodyCapped } from "../src/lib/http.ts";
import { HEARTBEAT_FRAME, broadcast, clearSubscribers, encodeFrame, subscriberCount, subscribe } from "../src/lib/sse.ts";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("令牌：首次生成 64 位十六进制、权限 0600，重复调用返回同一个", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-token-"));
  const path = join(dir, "token");
  try {
    const first = ensureToken(path);
    assert.match(first, /^[0-9a-f]{64}$/);

    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);

    assert.equal(ensureToken(path), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("令牌比较：等长才走 timingSafeEqual，长度不同直接 false", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", "abd"), false);
  assert.equal(tokensMatch("abc", "abcd"), false);
  assert.equal(tokensMatch(null, "abc"), false);
  assert.equal(tokensMatch("abc", ""), false);
});

test("请求体读取：超过上限被拒，且不把整段读进内存", async () => {
  const body = "x".repeat(100);
  const ok = await readBodyCapped(new Request("http://x/api/ingest", { method: "POST", body }), 200);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.text.length, 100);

  const tooBig = await readBodyCapped(new Request("http://x/api/ingest", { method: "POST", body }), 10);
  assert.equal(tooBig.ok, false);

  // 声明长度超限时直接拒，不读流
  const declared = await readBodyCapped(
    new Request("http://x/api/ingest", { method: "POST", body, headers: { "content-length": "100" } }),
    10,
  );
  assert.equal(declared.ok, false);
});

test("SSE 帧格式：命名事件带 data，心跳是注释行", () => {
  assert.equal(encodeFrame("probe.status", { connected: true }), 'event: probe.status\ndata: {"connected":true}\n\n');
  assert.equal(HEARTBEAT_FRAME, ": ping\n\n");
});

test("SSE 广播：订阅、取消订阅、单个订阅者出错不影响其他", () => {
  clearSubscribers();
  const seen: string[] = [];

  const off1 = subscribe((event) => seen.push(`a:${event.event}`));
  const off2 = subscribe(() => {
    throw new Error("订阅者自己炸了");
  });
  const off3 = subscribe((event) => seen.push(`c:${event.event}`));

  assert.equal(subscriberCount(), 3);
  broadcast("session.updated", { session_id: "s1" });
  assert.deepEqual(seen, ["a:session.updated", "c:session.updated"]);

  off1();
  off3();
  off2();
  assert.equal(subscriberCount(), 0);

  broadcast("session.updated", { session_id: "s1" });
  assert.equal(seen.length, 2);
});
