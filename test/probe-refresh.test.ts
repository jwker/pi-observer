import assert from "node:assert/strict";
import test from "node:test";

import type { ProbeConfig } from "../ext/config.ts";
import { refreshProbeConfig } from "../ext/refresh.ts";

function config(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    baseUrl: "http://127.0.0.1:4173",
    ingestUrl: "http://127.0.0.1:4173/api/ingest",
    healthUrl: "http://127.0.0.1:4173/api/health",
    tokenFile: "/data/token",
    batchSize: 50,
    batchIntervalMs: 300,
    maxBatchRecords: 200,
    maxBatchBytes: 1536 * 1024,
    maxQueueRecords: 2000,
    maxQueueBytes: 64 * 1024 * 1024,
    payloadDir: "/data/payloads",
    debugRequests: false,
    debug: false,
    ...overrides,
  };
}

test("配置没变：不算变化，保持原来那份", () => {
  const current = config();
  const result = refreshProbeConfig(current, () => config());
  assert.equal(result.changed, false);
  assert.equal(result.tokenFileChanged, false);
  assert.equal(result.config, current, "没变化时不该换对象");
});

test("地址变了：换配置，缓存令牌仍然有效", () => {
  const current = config();
  const next = config({
    baseUrl: "http://127.0.0.1:53124",
    ingestUrl: "http://127.0.0.1:53124/api/ingest",
    healthUrl: "http://127.0.0.1:53124/api/health",
  });
  const result = refreshProbeConfig(current, () => next);
  assert.equal(result.changed, true);
  assert.equal(result.tokenFileChanged, false);
  assert.equal(result.config.baseUrl, "http://127.0.0.1:53124");
});

test("令牌文件变了：缓存的令牌要作废", () => {
  const current = config();
  const result = refreshProbeConfig(current, () => config({ tokenFile: "/other/token" }));
  assert.equal(result.changed, true);
  assert.equal(result.tokenFileChanged, true);
  assert.equal(result.config.tokenFile, "/other/token");
});

test("正文目录变了：也算变化（新正文要写到新目录去）", () => {
  const current = config();
  const result = refreshProbeConfig(current, () => config({ payloadDir: "/other/payloads" }));
  assert.equal(result.changed, true);
  assert.equal(result.tokenFileChanged, false);
  assert.equal(result.config.payloadDir, "/other/payloads");
});

test("读配置失败：保持原样，不能把地址清空", () => {
  const current = config();
  const result = refreshProbeConfig(current, () => {
    throw new Error("读不到");
  });
  assert.equal(result.changed, false);
  assert.equal(result.config, current);
});
