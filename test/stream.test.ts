import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionStream, turnWindow } from "../src/lib/stream.ts";
import type {
  EventRow,
  RequestIndexRow,
  SessionRow,
  SessionStreamData,
  TimelineMessageRow,
  ToolCallIndexRow,
  TurnRow,
} from "../src/lib/types.ts";

/** 2026-10-19T08:00:00.000Z 之后第 ms 毫秒 */
const T = (ms: number) => new Date(Date.UTC(2026, 9, 19, 8, 0, 0, ms)).toISOString();

function session(state: string = "idle"): SessionRow {
  return {
    session_id: "s1",
    cwd: "/tmp/proj",
    file_path: null,
    parent_session: null,
    name: null,
    started_at: T(0),
    last_activity_at: T(9000),
    message_count: 0,
    turn_count: 0,
    tool_call_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost: 0,
    state,
    source: "merged",
    last_reconciled_at: null,
  };
}

function message(
  partial: Partial<TimelineMessageRow> & { entry_id: string; entry_index: number },
): TimelineMessageRow {
  return {
    parent_id: null,
    kind: "message",
    role: "user",
    timestamp: null,
    text: null,
    thinking: null,
    payload_bytes: 0,
    ...partial,
  };
}

function turn(partial: Partial<TurnRow> & { message_entry_id: string; run_seq: number; turn_index: number }): TurnRow {
  return {
    id: 0,
    session_id: "s1",
    started_at: null,
    ended_at: null,
    stop_reason: null,
    thinking_level: null,
    tokens_in: null,
    tokens_out: null,
    cache_read: null,
    cache_write: null,
    cost: null,
    ...partial,
  };
}

function tool(
  partial: Partial<ToolCallIndexRow> & { tool_call_id: string },
): ToolCallIndexRow {
  return {
    session_id: "s1",
    tool_name: "bash",
    is_error: 0,
    duration_ms: null,
    started_at: null,
    ended_at: null,
    parent_tool_call_id: null,
    run_seq: null,
    turn_index: null,
    entry_id: null,
    result_entry_id: null,
    args_bytes: 0,
    result_bytes: 0,
    args_preview: null,
    result_preview: null,
    ...partial,
  };
}

function event(
  partial: Partial<EventRow> & { event_id: string; event_type: string },
): EventRow {
  return {
    id: 0,
    session_id: "s1",
    layer: "session",
    run_seq: null,
    turn_index: null,
    payload: null,
    occurred_at: null,
    received_at: T(0),
    ...partial,
  };
}

function request(
  partial: Partial<RequestIndexRow> & { request_seq: number; created_at: string },
): RequestIndexRow {
  return {
    id: 0,
    session_id: "s1",
    provider: "deepseek",
    api: "openai-completions",
    model: "deepseek-v4-pro",
    payload_bytes: 1024,
    payload_truncated: 0,
    status: 200,
    run_seq: null,
    turn_index: null,
    response_headers_bytes: 100,
    tokens_in: null,
    tokens_out: null,
    cost: null,
    ...partial,
  };
}

function data(partial: Partial<SessionStreamData> = {}): SessionStreamData {
  const messages = partial.messages ?? [];
  const turns = partial.turns ?? [];
  const events = partial.events ?? [];
  const tools = partial.tools ?? [];
  const requests = partial.requests ?? [];
  return {
    session: partial.session ?? session(),
    messages,
    turns,
    events,
    tools,
    requests,
    totals: {
      messages: messages.length,
      turns: turns.length,
      events: events.length,
      tools: tools.length,
      requests: requests.length,
    },
  };
}

test("用户 Turn：prelude、多个模型 Turn 合并、工具 / 请求关联与统计", () => {
  const stream = buildSessionStream(
    data({
      messages: [
        message({
          entry_id: "u1",
          entry_index: 1,
          timestamp: T(1000),
          text: "看下这个文件",
        }),
        message({
          entry_id: "a1",
          entry_index: 2,
          parent_id: "u1",
          role: "assistant",
          timestamp: T(2000),
          text: "[思考] [工具调用：read]",
          thinking: "先读文件",
          payload_bytes: 100,
        }),
        message({
          entry_id: "t1",
          entry_index: 3,
          parent_id: "a1",
          role: "toolResult",
          timestamp: T(3000),
          text: "文件内容",
        }),
        message({
          entry_id: "a2",
          entry_index: 4,
          parent_id: "t1",
          role: "assistant",
          timestamp: T(4000),
          text: "这个文件是入口",
        }),
        message({
          entry_id: "u2",
          entry_index: 5,
          parent_id: "a2",
          timestamp: T(5000),
          text: "提交",
        }),
        message({
          entry_id: "a3",
          entry_index: 6,
          parent_id: "u2",
          role: "assistant",
          timestamp: T(6000),
          text: "已提交",
        }),
      ],
      turns: [
        turn({
          message_entry_id: "a1",
          run_seq: 1,
          turn_index: 0,
          started_at: T(1000),
          ended_at: T(3000),
          stop_reason: "toolUse",
          tokens_in: 100,
          tokens_out: 20,
          cache_read: 30,
          cache_write: 5,
          cost: 0.01,
        }),
        turn({
          message_entry_id: "a2",
          run_seq: 1,
          turn_index: 1,
          started_at: T(3000),
          ended_at: T(4000),
          stop_reason: "stop",
          tokens_in: 200,
          tokens_out: 50,
          cache_read: 20,
          cost: 0.02,
        }),
        turn({
          message_entry_id: "a3",
          run_seq: 2,
          turn_index: 0,
          started_at: T(5000),
          ended_at: T(6000),
          stop_reason: "stop",
          tokens_in: 50,
          tokens_out: 10,
          cost: 0.005,
        }),
      ],
      tools: [
        tool({
          tool_call_id: "call_1",
          entry_id: "a1",
          result_entry_id: "t1",
          run_seq: 1,
          turn_index: 0,
          started_at: T(2000),
          ended_at: T(3000),
          duration_ms: 12,
          args_preview: '{"path":"/tmp/proj/x.ts"}',
          result_preview: "文件内容",
          result_bytes: 12,
          args_bytes: 30,
        }),
      ],
      requests: [
        request({
          request_seq: 7,
          created_at: T(1500),
          run_seq: 1,
          turn_index: 0,
        }),
      ],
      events: [
        event({
          event_id: "e1",
          event_type: "session_start",
          occurred_at: T(0),
          payload: { reason: "startup" },
        }),
        event({
          event_id: "e2",
          event_type: "agent_start",
          occurred_at: T(1000),
          layer: "agent",
          payload: { runSeq: 1 },
        }),
        event({
          event_id: "e3",
          event_type: "provider_request",
          occurred_at: T(1500),
          layer: "provider",
          run_seq: 1,
          turn_index: 0,
          payload: { requestSeq: 7, payloadBytes: 1024 },
        }),
        event({
          event_id: "e4",
          event_type: "provider_response",
          occurred_at: T(1900),
          layer: "provider",
          run_seq: 1,
          turn_index: 0,
          payload: { requestSeq: 7, status: 200 },
        }),
        event({
          event_id: "e5",
          event_type: "tool_execution_start",
          occurred_at: T(2000),
          layer: "tool",
          run_seq: 1,
          turn_index: 0,
          payload: { toolCallId: "call_1", toolName: "read" },
        }),
        event({
          event_id: "e6",
          event_type: "tool_execution_end",
          occurred_at: T(3000),
          layer: "tool",
          run_seq: 1,
          turn_index: 0,
          payload: { toolCallId: "call_1", toolName: "read", isError: false },
        }),
        event({
          event_id: "e7",
          event_type: "agent_end",
          occurred_at: T(6200),
          layer: "agent",
          payload: { runSeq: 1, messageCount: 3 },
        }),
        event({
          event_id: "e8",
          event_type: "agent_settled",
          occurred_at: T(6300),
          layer: "agent",
          payload: { runSeq: 1, aborted: false },
        }),
        event({
          event_id: "e9",
          event_type: "session_shutdown",
          occurred_at: T(7000),
          payload: { reason: "quit" },
        }),
        event({
          event_id: "e10",
          event_type: "message_start",
          occurred_at: T(1000),
          run_seq: 1,
          turn_index: 0,
          payload: { role: "user" },
        }),
      ],
    }),
  );

  assert.equal(stream.turns.length, 2);
  assert.equal(stream.prelude?.rows.map((row) => row.key).join(","), "event:e1");
  assert.equal(stream.prelude?.rows[0]?.category, "session");

  const first = stream.turns[0];
  assert.ok(first);
  assert.equal(first.index, 1);
  assert.equal(first.summary, "看下这个文件");
  assert.equal(first.stats.toolCount, 1);
  assert.equal(first.stats.toolErrors, 0);
  assert.equal(first.stats.tokensIn, 300);
  assert.equal(first.stats.tokensOut, 70);
  assert.equal(first.stats.cacheRead, 50);
  assert.equal(first.stats.cacheWrite, 5);
  assert.ok(Math.abs(first.stats.cost - 0.03) < 1e-9);
  assert.equal(first.stopReason, "stop");
  assert.equal(first.failed, false);
  assert.ok(first.entryIds.includes("t1"));

  const rowKinds = first.rows.map((row) => `${row.kind}:${row.label}`);
  assert.deepEqual(rowKinds, [
    "user:用户",
    "request:provider →",
    "response:provider ←",
    "assistant:助手",
    "tool:bash",
    "assistant:助手",
  ]);

  const requestRow = first.rows.find((row) => row.kind === "request");
  assert.ok(requestRow);
  assert.equal(requestRow.category, "model");
  assert.equal(requestRow.requestSeq, 7);
  assert.equal(requestRow.status, 200);
  assert.deepEqual(requestRow.relatedEventIds.sort(), ["e3", "e4"]);

  const responseRow = first.rows.find((row) => row.kind === "response");
  assert.ok(responseRow);
  assert.equal(responseRow.requestSeq, 7);
  assert.equal(responseRow.text, "200 OK");
  assert.equal(responseRow.status, 200);
  assert.equal(responseRow.durationMs, 400);
  assert.deepEqual(responseRow.relatedEventIds, ["e4"]);

  const toolRow = first.rows.find((row) => row.kind === "tool");
  assert.ok(toolRow);
  assert.equal(toolRow.toolCallId, "call_1");
  assert.equal(toolRow.text, "/tmp/proj/x.ts");
  assert.equal(toolRow.resultPreview, "文件内容");
  assert.equal(toolRow.fromFile, true);
  assert.deepEqual(toolRow.relatedEventIds.sort(), ["e5", "e6"]);

  assert.ok(first.eventIds.includes("e10"), "旧版 message_start 仍留在 Turn 的事件清单里");
  assert.equal(first.rows.some((row) => row.eventId === "e10"), false, "旧版事件不单独成行");

  const second = stream.turns[1];
  assert.ok(second);
  assert.equal(second.summary, "提交");
  assert.deepEqual(
    second.rows.map((row) => row.kind),
    ["user", "assistant", "event", "event"],
  );
  assert.ok(second.eventIds.includes("e7"), "agent_end 不单独成行，但仍在事件清单里");

  assert.equal(stream.branch.entries, 6);
  assert.equal(stream.branch.current, 6);
  assert.equal(stream.branch.offCurrent, 0);
  assert.equal(stream.running, false);

  const page1 = turnWindow(stream, 1, 1);
  assert.deepEqual(page1.turns.map((item) => item.index), [2]);
  assert.equal(page1.prelude, null);
  assert.equal(page1.hasEarlier, true);
  assert.equal(page1.total, 2);

  const page2 = turnWindow(stream, 2, 1);
  assert.deepEqual(page2.turns.map((item) => item.index), [1, 2]);
  assert.equal(page2.prelude?.rows.length, 1);
  assert.equal(page2.hasEarlier, false);
});

test("旁支：当前分支之外的助手行保留但不计入统计", () => {
  const stream = buildSessionStream(
    data({
      messages: [
        message({ entry_id: "u1", entry_index: 1, timestamp: T(1000), text: "问" }),
        message({
          entry_id: "a1",
          entry_index: 2,
          parent_id: "u1",
          role: "assistant",
          timestamp: T(2000),
          text: "先调工具",
        }),
        message({
          entry_id: "b1",
          entry_index: 3,
          parent_id: "a1",
          role: "assistant",
          timestamp: T(3000),
          text: "旁支答法",
        }),
        message({
          entry_id: "a2",
          entry_index: 4,
          parent_id: "a1",
          role: "assistant",
          timestamp: T(4000),
          text: "当前答法",
        }),
      ],
      turns: [
        turn({
          message_entry_id: "a1",
          run_seq: 1,
          turn_index: 0,
          tokens_in: 10,
          stop_reason: "toolUse",
        }),
        turn({
          message_entry_id: "b1",
          run_seq: 1,
          turn_index: 1,
          tokens_in: 999,
          stop_reason: "stop",
        }),
        turn({
          message_entry_id: "a2",
          run_seq: 1,
          turn_index: 2,
          tokens_in: 20,
          stop_reason: "stop",
        }),
      ],
    }),
  );

  assert.equal(stream.branch.forks, 1);
  assert.equal(stream.branch.offCurrent, 1);
  assert.equal(stream.turns.length, 1);

  const only = stream.turns[0];
  assert.ok(only);
  assert.equal(only.onCurrentBranch, true);
  assert.equal(only.stats.tokensIn, 30, "旁支 b1 的 token 不计入当前 Turn");
  assert.equal(only.stopReason, "stop");

  const offBranch = only.rows.find((row) => row.entryId === "b1");
  assert.ok(offBranch);
  assert.equal(offBranch.onCurrentBranch, false);
  assert.equal(offBranch.branchStart, true);
});

test("进行中：active 会话最后一个 Turn 末尾加等待行", () => {
  const stream = buildSessionStream(
    data({
      session: session("active"),
      messages: [
        message({ entry_id: "u1", entry_index: 1, timestamp: T(1000), text: "继续" }),
        message({
          entry_id: "a1",
          entry_index: 2,
          parent_id: "u1",
          role: "assistant",
          timestamp: T(2000),
          text: "处理中",
        }),
      ],
      turns: [
        turn({
          message_entry_id: "a1",
          run_seq: 1,
          turn_index: 0,
          tokens_in: 10,
          stop_reason: "toolUse",
        }),
      ],
    }),
  );

  assert.equal(stream.running, true);
  const only = stream.turns[0];
  assert.ok(only);
  assert.equal(only.running, true);
  assert.equal(only.rows.at(-1)?.kind, "pending");
  assert.equal(only.rows.at(-1)?.at, null);
});

test("没有条目引用的工具：按 run_seq / turn_index 挂回 Turn", () => {
  const stream = buildSessionStream(
    data({
      messages: [
        message({ entry_id: "u1", entry_index: 1, timestamp: T(1000), text: "列目录" }),
        message({
          entry_id: "a1",
          entry_index: 2,
          parent_id: "u1",
          role: "assistant",
          timestamp: T(2000),
          text: "看一下",
        }),
      ],
      turns: [
        turn({
          message_entry_id: "a1",
          run_seq: 1,
          turn_index: 0,
          stop_reason: "stop",
        }),
      ],
      tools: [
        tool({
          tool_call_id: "call_live",
          run_seq: 1,
          turn_index: 0,
          started_at: T(1500),
          args_preview: '{"command":"ls -la"}',
        }),
      ],
    }),
  );

  const only = stream.turns[0];
  assert.ok(only);
  const row = only.rows.find((item) => item.kind === "tool");
  assert.ok(row);
  assert.equal(row.toolCallId, "call_live");
  assert.equal(row.text, "ls -la");
  assert.equal(row.fromFile, false);
  assert.equal(only.stats.toolCount, 1);
});

test("请求行缺失时 provider 事件自己成行；无时间事件落到最后一个 Turn", () => {
  const stream = buildSessionStream(
    data({
      messages: [
        message({ entry_id: "u1", entry_index: 1, timestamp: T(1000), text: "问" }),
        message({
          entry_id: "a1",
          entry_index: 2,
          parent_id: "u1",
          role: "assistant",
          timestamp: T(2000),
          text: "答",
        }),
      ],
      events: [
        event({
          event_id: "p1",
          event_type: "provider_request",
          occurred_at: T(1500),
          layer: "provider",
          run_seq: 1,
          turn_index: 0,
          payload: { requestSeq: 99, payloadBytes: 12 },
        }),
        event({
          event_id: "s1",
          event_type: "session_info_changed",
          occurred_at: null,
          payload: { name: "新名字" },
        }),
      ],
    }),
  );

  const only = stream.turns[0];
  assert.ok(only);
  const providerRow = only.rows.find((row) => row.eventId === "p1");
  assert.ok(providerRow);
  assert.equal(providerRow.category, "model");
  assert.equal(providerRow.kind, "event");

  const noTime = only.rows.find((row) => row.eventId === "s1");
  assert.ok(noTime);
  assert.equal(noTime.at, null);
  assert.equal(noTime.text, "名称 → 新名字");
  assert.equal(only.rows.at(-1)?.eventId, "s1");
});
