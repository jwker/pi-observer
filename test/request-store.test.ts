/**
 * 请求文件：文件名规则与「请求 ↔ 助手消息」的对号。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { config, setConfig } from "../src/lib/config.ts";
import {
  listRequestFiles,
  matchRequests,
  parseRequestFileName,
  requestFileName,
  requestFileSize,
} from "../src/lib/request-store.ts";
import type { ParsedEntry } from "../src/lib/session-parse.ts";

function entry(partial: Partial<ParsedEntry> & { entry_id: string }): ParsedEntry {
  return {
    parent_id: null,
    kind: "message",
    role: "assistant",
    timestamp: null,
    entry_index: 0,
    text: null,
    thinking: null,
    tool_calls: [],
    tool_call_id: null,
    tool_name: null,
    is_error: false,
    duration_ms: null,
    usage: null,
    provider: null,
    model: null,
    api: null,
    stop_reason: null,
    thinking_level: null,
    response_id: null,
    payload_bytes: 0,
    ...partial,
  };
}

function withStore<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pi-observer-requests-"));
  const previous = config();
  setConfig({ sessionsDir: previous.sessionsDir, requestStoreDir: root });
  try {
    return run(root);
  } finally {
    setConfig(previous);
    rmSync(root, { recursive: true, force: true });
  }
}

test("文件名能生成也能解析", () => {
  const name = requestFileName(7, new Date("2026-11-02T11:40:49.412Z"));
  assert.equal(name, "req-000007-20261102T114049412Z.json");
  const parsed = parseRequestFileName(name);
  assert.ok(parsed);
  assert.equal(parsed.seq, 7);
  assert.equal(parsed.written_at, "2026-11-02T11:40:49.412Z");
  assert.equal(parseRequestFileName("别的文件.json"), null);
});

test("列目录只取本项目的文件", () => {
  withStore((root) => {
    const dir = join(root, "sess-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, requestFileName(1, new Date("2026-11-02T11:40:49.412Z"))), "{}", "utf8");
    writeFileSync(join(dir, "别的东西.json"), "{}", "utf8");
    const files = listRequestFiles("sess-1");
    assert.equal(files.length, 1);
    assert.equal(files[0]?.seq, 1);
    assert.equal(requestFileSize(files[0]!), 2);
  });
});

test("请求按时间对上助手消息", () => {
  const files = [
    { id: "req-000001-20261102T114049412Z", filename: "a.json", path: "/a", seq: 1, written_at: "2026-11-02T11:40:49.412Z", size_bytes: 10 },
    { id: "req-000002-20261102T114056412Z", filename: "b.json", path: "/b", seq: 2, written_at: "2026-11-02T11:40:56.412Z", size_bytes: 10 },
  ];
  const entries = [
    entry({ entry_id: "a1", timestamp: "2026-11-02T11:40:53.023Z" }),
    entry({ entry_id: "a2", timestamp: "2026-11-02T11:41:00.000Z" }),
  ];
  const { matched, unmatched } = matchRequests(entries, files);
  assert.equal(matched.get("a1")?.id, "req-000001-20261102T114049412Z");
  assert.equal(matched.get("a2")?.id, "req-000002-20261102T114056412Z");
  assert.equal(unmatched, 0);
});

test("失败重试多出来的请求对不上任何消息", () => {
  const files = [
    { id: "req-000001-20261102T114049412Z", filename: "a.json", path: "/a", seq: 1, written_at: "2026-11-02T11:40:49.412Z", size_bytes: 10 },
    { id: "req-000002-20261102T114050412Z", filename: "b.json", path: "/b", seq: 2, written_at: "2026-11-02T11:40:50.412Z", size_bytes: 10 },
  ];
  const entries = [entry({ entry_id: "a1", timestamp: "2026-11-02T11:40:53.023Z" })];
  const { matched, unmatched } = matchRequests(entries, files);
  assert.equal(matched.get("a1")?.id, "req-000002-20261102T114050412Z");
  assert.equal(unmatched, 0);
});

test("早于第一条助手消息的请求留在外面", () => {
  const files = [
    { id: "req-000001-20261102T114000412Z", filename: "a.json", path: "/a", seq: 1, written_at: "2026-11-02T11:40:00.412Z", size_bytes: 10 },
  ];
  const entries = [entry({ entry_id: "a1", timestamp: "2026-11-02T11:40:53.023Z" })];
  const { matched } = matchRequests(entries, files);
  assert.equal(matched.get("a1")?.id, "req-000001-20261102T114000412Z");
});
