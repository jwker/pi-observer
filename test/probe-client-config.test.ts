import assert from "node:assert/strict";
import test from "node:test";

import { BACKOFF_STEPS_MS, backoffDelay, checkHealth, getSessionCursor, postBatch } from "../ext/client.ts";
import { loadProbeConfig, defaultTokenFile } from "../ext/config.ts";
import { capText, capValue, jsonBytes } from "../ext/limit.ts";
import { PROBE_PROTOCOL_VERSION, type IngestBatch } from "../src/lib/protocol.ts";

const batch: IngestBatch = {
  protocol: PROBE_PROTOCOL_VERSION,
  probe_version: "0.1.0",
  dropped_count: 0,
  queue_depth: 0,
  records: [
    {
      kind: "event",
      event_id: "e1",
      session_id: "s1",
      layer: "agent",
      event_type: "agent_start",
      payload: {},
      occurred_at: null,
      run_seq: 1,
      turn_index: 0,
    },
  ],
};

test("退避档位：1s → 2s → 5s → 10s → 15s，之后停在 15s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffDelay), [1000, 2000, 5000, 10000, 15000, 15000, 15000]);
  assert.equal(BACKOFF_STEPS_MS.length, 5);
  assert.equal(backoffDelay(-3), 1000);
});

function fakeResponse(status: number, body: string) {
  return { status, text: async () => body };
}

test("postBatch：2xx 视为成功并带回落库统计", async () => {
  const outcome = await postBatch({
    url: "http://127.0.0.1:4173/api/ingest",
    token: "t",
    batch,
    fetchImpl: async () => fakeResponse(200, JSON.stringify({ ok: true, accepted: 1, applied: { event: 1 } })),
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.applied.event, 1);
});

test("postBatch：5xx / 401 / 404 / 405 / 网络错误可重试，400 / 413 不可重试", async () => {
  const serverError = await postBatch({
    url: "u",
    token: "t",
    batch,
    fetchImpl: async () => fakeResponse(500, "boom"),
  });
  assert.deepEqual(serverError, { ok: false, retryable: true, reason: "HTTP 500 boom", status: 500 });

  const networkError = await postBatch({
    url: "u",
    token: "t",
    batch,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(networkError.ok, false);
  if (!networkError.ok) assert.equal(networkError.retryable, true);

  // 401 / 404 / 405 都先重试：丢掉数据没有意义，而这三个状态经常是「令牌过期 / 路由暂时不存在」
  for (const status of [401, 404, 405, 408, 429]) {
    const retryable = await postBatch({
      url: "u",
      token: "t",
      batch,
      fetchImpl: async () => fakeResponse(status, "nope"),
    });
    assert.equal(retryable.ok, false);
    if (!retryable.ok) assert.equal(retryable.retryable, true, `HTTP ${status} 该重试`);
    if (!retryable.ok) assert.equal(retryable.status, status);
  }

  // 400（形状 / 协议不对）与 413（这批太大）重发还是一样 → 丢弃
  for (const status of [400, 413]) {
    const fatal = await postBatch({
      url: "u",
      token: "t",
      batch,
      fetchImpl: async () => fakeResponse(status, "nope"),
    });
    assert.equal(fatal.ok, false);
    if (!fatal.ok) assert.equal(fatal.retryable, false, `HTTP ${status} 不该重试`);
  }
});

test("postBatch：会带上令牌请求头", async () => {
  let seenToken: string | undefined;
  await postBatch({
    url: "u",
    token: "secret-token",
    batch,
    fetchImpl: async (_input, init) => {
      seenToken = init?.headers?.["x-observer-token"];
      return fakeResponse(200, "{}");
    },
  });
  assert.equal(seenToken, "secret-token");
});

test("checkHealth：可达返回 true，抛错返回 false", async () => {
  assert.equal(await checkHealth({ url: "u", fetchImpl: async () => fakeResponse(200, "{}") }), true);
  assert.equal(await checkHealth({ url: "u", fetchImpl: async () => fakeResponse(503, "") }), false);
  assert.equal(
    await checkHealth({
      url: "u",
      fetchImpl: async () => {
        throw new Error("down");
      },
    }),
    false,
  );
});

test("探针配置：默认地址、批量与队列上限", () => {
  const config = loadProbeConfig({});
  assert.equal(config.baseUrl, "http://127.0.0.1:4173");
  assert.equal(config.ingestUrl, "http://127.0.0.1:4173/api/ingest");
  assert.equal(config.batchSize, 50);
  assert.equal(config.maxQueueRecords, 2000);
  assert.equal(config.maxQueueBytes, 64 * 1024 * 1024);
  assert.equal(config.maxRecordBytes, 512 * 1024);
  assert.equal(config.debugRequests, false);
  assert.equal(config.debug, false, "默认不打 stderr，避免打扰用户的终端");
  assert.ok(config.tokenFile === defaultTokenFile());
  assert.ok(config.tokenFile.endsWith("/data/token"));
});

test("探针配置：环境变量可覆盖地址与上限", () => {
  const config = loadProbeConfig({
    PI_OBSERVER_URL: "http://127.0.0.1:9999/",
    PI_OBSERVER_BATCH_SIZE: "10",
    PI_OBSERVER_TOKEN_FILE: "/tmp/token",
    PI_OBSERVER_MAX_QUEUE_RECORDS: "5",
    PI_OBSERVER_DEBUG_REQUESTS: "1",
    PI_OBSERVER_DEBUG: "1",
  });
  assert.equal(config.baseUrl, "http://127.0.0.1:9999");
  assert.equal(config.ingestUrl, "http://127.0.0.1:9999/api/ingest");
  assert.equal(config.batchSize, 10);
  assert.equal(config.tokenFile, "/tmp/token");
  assert.equal(config.maxQueueRecords, 5);
  assert.equal(config.debugRequests, true);
  assert.equal(config.debug, true);
});

test("单条上限：超限给合法标记，capText 不切断多字节字符", () => {
  const small = capValue({ a: 1 }, 100);
  assert.equal(small.truncated, false);

  const big = capValue({ text: "x".repeat(500) }, 50);
  assert.equal(big.truncated, true);
  assert.equal(JSON.parse(JSON.stringify(big.value)).truncated, true);

  const text = "中文".repeat(50);
  const capped = capText(text, 10);
  assert.ok(capped.startsWith("中文"));
  assert.ok(capped.includes("已截断"));
  assert.ok(!capped.includes("\uFFFD"), "不能出现替换字符（说明按字节切坏了）");

  assert.equal(jsonBytes({ a: 1 }), 7);
  assert.equal(capText("短", 100), "短");
});

test("会话游标：从看板读最大序号；接口不可用或返回体不合法时返回 null", async () => {
  const ok = await getSessionCursor({
    url: "u",
    fetchImpl: async () => fakeResponse(200, JSON.stringify({ ok: true, request_seq_max: 7, run_seq_max: 3 })),
  });
  assert.deepEqual(ok, { requestSeq: 7, runSeq: 3 });

  const missing = await getSessionCursor({
    url: "u",
    fetchImpl: async () => fakeResponse(404, "nope"),
  });
  assert.equal(missing, null);

  const broken = await getSessionCursor({
    url: "u",
    fetchImpl: async () => fakeResponse(200, "not-json"),
  });
  assert.equal(broken, null);
});
