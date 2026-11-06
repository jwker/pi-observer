/**
 * 会话文件解析：条目、摘要、用量与聚合。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSessionFile } from "../src/main/lib/session-parse.ts";

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const HEADER = {
  type: "session",
  version: 3,
  id: "sess-1",
  timestamp: "2026-11-02T11:40:26.856Z",
  cwd: "/tmp/demo",
};

const USER = {
  type: "message",
  id: "u1",
  parentId: null,
  timestamp: "2026-11-02T11:40:30.000Z",
  message: { role: "user", content: [{ type: "text", text: "读一下 README" }] },
};

const ASSISTANT = {
  type: "message",
  id: "a1",
  parentId: "u1",
  timestamp: "2026-11-02T11:40:53.023Z",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "好" },
      { type: "thinking", thinking: "先看看文件" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
    ],
    provider: "opencode-go",
    model: "deepseek",
    api: "openai-completions",
    stopReason: "toolUse",
    thinkingLevel: "high",
    responseId: "resp-1",
    durationMs: 3661,
    usage: {
      input: 6300,
      output: 160,
      cacheRead: 256,
      cacheWrite: 0,
      cost: { total: 0.001 },
    },
  },
};

const TOOL_RESULT = {
  type: "message",
  id: "t1",
  parentId: "a1",
  timestamp: "2026-11-02T11:40:54.000Z",
  message: {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    isError: false,
    durationMs: 12,
    content: [{ type: "text", text: "文件内容" }],
  },
};

async function withFixture<T>(
  body: string,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-parse-"));
  const path = join(dir, "2026-11-02T11-40-26-856Z_sess-1.jsonl");
  writeFileSync(path, body, "utf8");
  try {
    return await run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("解析会话头与各类条目", async () => {
  const body = line(HEADER) + line(USER) + line(ASSISTANT) + line(TOOL_RESULT);
  await withFixture(body, async (path) => {
    const parsed = await parseSessionFile(path);
    assert.ok(parsed);
    assert.equal(parsed.session_id, "sess-1");
    assert.equal(parsed.cwd, "/tmp/demo");
    assert.equal(parsed.version, 3);
    assert.equal(parsed.entries.length, 3);

    const [user, assistant, tool] = parsed.entries;
    assert.equal(user.role, "user");
    assert.equal(user.text, "读一下 README");

    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.text, "好");
    assert.equal(assistant.thinking, "先看看文件");
    assert.equal(assistant.tool_calls.length, 1);
    assert.equal(assistant.tool_calls[0]?.name, "read");
    assert.match(assistant.tool_calls[0]?.args_preview ?? "", /README\.md/);
    assert.equal(assistant.model, "deepseek");
    assert.equal(assistant.stop_reason, "toolUse");
    assert.equal(assistant.usage?.input, 6300);
    assert.equal(assistant.usage?.cost, 0.001);

    assert.equal(tool.role, "toolResult");
    assert.equal(tool.tool_call_id, "call-1");
    assert.equal(tool.tool_name, "read");
    assert.equal(tool.is_error, false);
    assert.equal(tool.duration_ms, 12);
    assert.equal(tool.text, "文件内容");
  });
});

test("工具失败与用量聚合", async () => {
  const failedTool = {
    ...TOOL_RESULT,
    id: "t2",
    message: { ...TOOL_RESULT.message, isError: true, content: [{ type: "text", text: "找不到" }] },
  };
  const body = line(HEADER) + line(USER) + line(ASSISTANT) + line(failedTool);
  await withFixture(body, async (path) => {
    const parsed = await parseSessionFile(path);
    assert.ok(parsed);
    const tool = parsed.entries[2];
    assert.equal(tool?.is_error, true);
    assert.equal(parsed.aggregates.assistant_count, 1);
    assert.equal(parsed.aggregates.tool_call_count, 1);
    assert.equal(parsed.aggregates.tokens_in, 6300);
    assert.equal(parsed.aggregates.tokens_out, 160);
    assert.equal(parsed.aggregates.cost, 0.001);
  });
});

test("非消息条目给出一行说明", async () => {
  const body =
    line(HEADER) +
    line({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-11-02T11:40:26.977Z", modelId: "x" }) +
    line({ type: "thinking_level_change", id: "th1", parentId: "m1", timestamp: "2026-11-02T11:40:26.977Z", thinkingLevel: "medium" });
  await withFixture(body, async (path) => {
    const parsed = await parseSessionFile(path);
    assert.ok(parsed);
    assert.equal(parsed.entries[0]?.text, "模型 → x");
    assert.equal(parsed.entries[1]?.text, "思考等级 → medium");
  });
});

test("坏行跳过，不影响其余条目", async () => {
  const body = line(HEADER) + "{ 这不是 JSON\n" + line(USER);
  await withFixture(body, async (path) => {
    const parsed = await parseSessionFile(path);
    assert.ok(parsed);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0]?.role, "user");
  });
});
