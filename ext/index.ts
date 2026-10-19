/**
 * pi-observer 探针（Pi 扩展）。
 *
 * 只做三件事：订阅通知型事件、就地合并高频流、批量推到看板服务。
 * 只读约束（PRD §7.2）：所有 handler 返回 `undefined`，全部包在 try/catch 里，
 * 不调用任何写入 API，不修改 event 对象。
 *
 * 生命周期（PRD §7.1）：工厂函数只注册 handler；队列、定时器、令牌都在
 * `session_start` 里建；`session_shutdown` 幂等收尾。
 *
 * 事件清单与订阅取舍见 PRD §5.2；`before_provider_request` / `after_provider_response`
 * 属 M3，本文件暂不订阅。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  PROBE_VERSION,
  type EventLayer,
  type IngestRecord,
  type SessionRecord,
  type TurnRecord,
} from "../src/lib/protocol.ts";
import { checkHealth } from "./client.ts";
import { loadProbeConfig, type ProbeConfig } from "./config.ts";
import { createFlusher, type Flusher } from "./flush.ts";
import { capText, capValue } from "./limit.ts";
import { MergeTable, assistantLike, extractParts } from "./merge.ts";
import { BoundedQueue } from "./queue.ts";

interface SessionInfo {
  sessionId: string;
  filePath: string | null;
  cwd: string;
  name: string | null;
  version: number | null;
}

interface ProbeState {
  config: ProbeConfig;
  session: SessionInfo | null;
  queue: BoundedQueue<IngestRecord>;
  flusher: Flusher;
  merge: MergeTable;
  token: string | null;
  runSeq: number;
  runStartedAt: string | null;
  turnIndex: number;
  turnStartedAt: string | null;
  batchTimer: ReturnType<typeof setInterval> | null;
  progressTimer: ReturnType<typeof setInterval> | null;
  /** 被服务端拒绝而丢掉的条数，计入上报的 dropped_count */
  rejectedByServer: number;
  lastActivity: string;
}

let state: ProbeState | null = null;

const nowIso = (): string => new Date().toISOString();

function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 1024;
  }
}

/** 每个 handler 的外壳：异常只写本地日志，绝不向 Pi 抛出（PRD §7.2） */
function safe(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    try {
      console.error(`[pi-observer] ${label} 处理失败：${(error as Error).message}`);
    } catch {
      // 连日志都失败就算了
    }
  }
}

function sessionInfo(ctx: ExtensionContext): SessionInfo | null {
  try {
    const sessionManager = ctx.sessionManager;
    const sessionId = sessionManager.getSessionId();
    if (typeof sessionId !== "string" || sessionId === "") return null;

    let filePath: string | null = null;
    try {
      filePath = sessionManager.getSessionFile() ?? null;
    } catch {
      filePath = null;
    }

    let name: string | null = null;
    try {
      name = sessionManager.getSessionName() ?? null;
    } catch {
      name = null;
    }

    let version: number | null = null;
    try {
      const header = sessionManager.getHeader() as { version?: unknown } | undefined;
      version = typeof header?.version === "number" ? header.version : null;
    } catch {
      version = null;
    }

    return {
      sessionId,
      filePath,
      cwd: typeof ctx.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : "",
      name,
      version,
    };
  } catch {
    return null;
  }
}

function readToken(s: ProbeState): string | null {
  if (s.token) return s.token;
  try {
    const token = readFileSync(s.config.tokenFile, "utf8").trim();
    if (token !== "") s.token = token;
  } catch {
    // 看板服务还没启动过，令牌文件还不存在；下次再试
  }
  return s.token;
}

/**
 * 发一批（内部使用抽出来的发送器）。
 * 退避闸门与「绕过退避」的取舍见 `ext/flush.ts` 的注释。
 */
async function flush(s: ProbeState, options: { ignoreBackoff?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
  return s.flusher.flush(options);
}

/** 退出收尾：在预算内反复发，直到队列清空或时间用完 */
async function drainWithin(s: ProbeState, budgetMs: number): Promise<number> {
  return s.flusher.drainWithin(budgetMs);
}

function emit(s: ProbeState, record: IngestRecord): void {
  s.queue.push(record);
  if (s.queue.depth >= s.config.batchSize) void flush(s);
}

function pushEvent(
  s: ProbeState,
  layer: EventLayer,
  eventType: string,
  payload: unknown,
  location?: { runSeq?: number | null; turnIndex?: number | null },
): void {
  if (!s.session) return;
  s.lastActivity = nowIso();
  emit(s, {
    kind: "event",
    event_id: randomUUID(),
    session_id: s.session.sessionId,
    layer,
    event_type: eventType,
    payload: capValue(payload, s.config.maxRecordBytes).value,
    occurred_at: s.lastActivity,
    run_seq: location?.runSeq !== undefined ? location.runSeq : (s.runStartedAt ? s.runSeq : null),
    turn_index: location?.turnIndex !== undefined ? location.turnIndex : (s.turnStartedAt ? s.turnIndex : null),
  });
}

function pushSession(s: ProbeState, stateName: SessionRecord["state"]): void {
  if (!s.session) return;
  emit(s, {
    kind: "session",
    session_id: s.session.sessionId,
    cwd: s.session.cwd,
    file_path: s.session.filePath,
    parent_session: null,
    version: s.session.version,
    name: s.session.name,
    started_at: null,
    last_activity_at: s.lastActivity,
    state: stateName,
    source: "live",
  });
}

function startTimers(s: ProbeState): void {
  stopTimers(s);
  s.batchTimer = setInterval(() => void flush(s), s.config.batchIntervalMs);
  s.batchTimer.unref?.();

  if (s.config.liveText) {
    s.progressTimer = setInterval(() => {
      for (const record of s.merge.drainProgress()) emit(s, record);
      for (const record of s.merge.drainToolPartials()) emit(s, record);
      void flush(s);
    }, s.config.progressIntervalMs);
    s.progressTimer.unref?.();
  }
}

/**
 * 给收尾 flush 加时限。
 * 注意 `setTimeout` 必须 `unref()` 并在结束时 `clearTimeout`：否则这个 3 秒的定时器
 * 会把 Node 的事件循环多留 3 秒，直接变成 Pi 退出时「恒定多花 3 秒」。
 */
async function flushWithin(s: ProbeState, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([drainWithin(s, ms - 100), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stopTimers(s: ProbeState): void {
  if (s.batchTimer) {
    clearInterval(s.batchTimer);
    s.batchTimer = null;
  }
  if (s.progressTimer) {
    clearInterval(s.progressTimer);
    s.progressTimer = null;
  }
}

export default function probe(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) =>
    safe("session_start", () => {
      const session = sessionInfo(ctx);
      if (!session) {
        console.error("[pi-observer] 拿不到会话信息，本会话不采集");
        return;
      }

      const config = loadProbeConfig();
      const queue = new BoundedQueue<IngestRecord>(jsonSize, {
        maxRecords: config.maxQueueRecords,
        maxBytes: config.maxQueueBytes,
      });

      const nextState: ProbeState = {
        config,
        session,
        queue,
        flusher: createFlusher({
          queue,
          ingestUrl: config.ingestUrl,
          token: () => readToken(nextState),
          rejectedCount: () => nextState.rejectedByServer,
          maxBatchRecords: config.maxBatchRecords,
          maxBatchBytes: config.maxBatchBytes,
          log: (message) => console.error(`[pi-observer] ${message}`),
        }),
        merge: new MergeTable(),
        token: null,
        runSeq: 0,
        runStartedAt: null,
        turnIndex: 0,
        turnStartedAt: null,
        batchTimer: null,
        progressTimer: null,
        rejectedByServer: 0,
        lastActivity: nowIso(),
      };
      state = nextState;

      pushEvent(state, "session", "session_start", {
        reason: event.reason,
        previousSessionFile: event.previousSessionFile ?? null,
        cwd: session.cwd,
        filePath: session.filePath,
        version: session.version,
        probeVersion: PROBE_VERSION,
        liveText: config.liveText,
      }, { runSeq: null, turnIndex: null });
      pushSession(state, "idle");
      startTimers(state);

      // 服务可用性探测：失败也不阻断，记录一条事件即可
      void checkHealth({ url: config.healthUrl }).then((healthy) => {
        if (!state || state.session?.sessionId !== session.sessionId) return;
        pushEvent(state, "session", "probe_health", { healthy, url: config.healthUrl });
      });
    }),
  );

  pi.on("session_info_changed", (event) =>
    safe("session_info_changed", () => {
      if (!state?.session) return;
      state.session.name = event.name ?? null;
      pushEvent(state, "session", "session_info_changed", { name: event.name ?? null });
      pushSession(state, "idle");
    }),
  );

  pi.on("session_compact", (event) =>
    safe("session_compact", () => {
      if (!state) return;
      pushEvent(state, "session", "session_compact", {
        reason: event.reason,
        fromExtension: event.fromExtension,
        willRetry: event.willRetry,
      });
    }),
  );

  pi.on("session_compact_failed", (event) =>
    safe("session_compact_failed", () => {
      if (!state) return;
      pushEvent(state, "session", "session_compact_failed", {
        reason: event.reason,
        errorMessage: event.errorMessage ?? null,
        aborted: event.aborted,
        willRetry: event.willRetry,
      });
    }),
  );

  pi.on("session_tree", (event) =>
    safe("session_tree", () => {
      if (!state) return;
      pushEvent(state, "session", "session_tree", {
        newLeafId: event.newLeafId,
        oldLeafId: event.oldLeafId,
        fromExtension: event.fromExtension ?? false,
      });
    }),
  );

  pi.on("agent_start", () =>
    safe("agent_start", () => {
      if (!state) return;
      state.runSeq += 1;
      state.runStartedAt = nowIso();
      state.turnIndex = 0;
      pushEvent(state, "agent", "agent_start", { runSeq: state.runSeq });
      emit(state, {
        kind: "run",
        session_id: state.session?.sessionId ?? "",
        run_seq: state.runSeq,
        started_at: state.runStartedAt,
        ended_at: null,
        outcome: null,
      });
      pushSession(state, "active");
    }),
  );

  pi.on("agent_end", (event) =>
    safe("agent_end", () => {
      if (!state) return;
      pushEvent(state, "agent", "agent_end", {
        runSeq: state.runSeq,
        messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
      });
    }),
  );

  pi.on("agent_settled", (event) =>
    safe("agent_settled", () => {
      if (!state) return;
      const endedAt = nowIso();
      pushEvent(state, "agent", "agent_settled", { runSeq: state.runSeq, aborted: event.aborted });
      emit(state, {
        kind: "run",
        session_id: state.session?.sessionId ?? "",
        run_seq: state.runSeq,
        started_at: state.runStartedAt,
        ended_at: endedAt,
        outcome: event.aborted ? "aborted" : "completed",
      });
      state.runStartedAt = null;
      pushSession(state, "idle");
    }),
  );

  pi.on("turn_start", (event) =>
    safe("turn_start", () => {
      if (!state) return;
      state.turnIndex = event.turnIndex;
      state.turnStartedAt = nowIso();
      pushEvent(state, "turn", "turn_start", { turnIndex: event.turnIndex, timestamp: event.timestamp }, {
        runSeq: state.runSeq,
        turnIndex: event.turnIndex,
      });
    }),
  );

  pi.on("turn_end", (event) =>
    safe("turn_end", () => {
      const s = state;
      if (!s?.session) return;

      const turnIndex = typeof event.turnIndex === "number" ? event.turnIndex : s.turnIndex;
      const snapshot = s.merge.consumeMessage(s.runSeq, turnIndex);
      const assistant = assistantLike(event.message);
      const parts = extractParts(assistant?.content);
      const text = parts.text !== "" ? parts.text : (snapshot?.text ?? "");
      const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
      const usage = assistant?.usage;
      const max = s.config.maxRecordBytes;

      pushEvent(s, "turn", "turn_end", {
        turnIndex,
        messageEntryId: event.messageEntryId,
        toolResultEntryIds: event.toolResultEntryIds ?? [],
        updateCount: snapshot?.updateCount ?? 0,
        stopReason: assistant?.stopReason ?? null,
        thinking: capText(parts.thinking, Math.floor(max / 4)),
        text: capText(text, max),
      }, { runSeq: s.runSeq, turnIndex });

      const record: TurnRecord = {
        kind: "turn",
        session_id: s.session.sessionId,
        run_seq: s.runSeq,
        turn_index: turnIndex,
        message_entry_id: event.messageEntryId,
        started_at: s.turnStartedAt ?? snapshot?.startedAt ?? null,
        ended_at: nowIso(),
        stop_reason: typeof assistant?.stopReason === "string" ? assistant.stopReason : null,
        thinking_level: typeof assistant?.thinkingLevel === "string" ? assistant.thinkingLevel : null,
        assistant_message: capValue(assistant ?? { role: "assistant", text }, max).value,
        tool_results: capValue(
          toolResults.map((result) => {
            const item = result as { toolCallId?: unknown; isError?: unknown };
            return {
              toolCallId: typeof item.toolCallId === "string" ? item.toolCallId : null,
              isError: item.isError === true,
            };
          }),
          max,
        ).value,
        tokens_in: typeof usage?.input === "number" ? usage.input : null,
        tokens_out: typeof usage?.output === "number" ? usage.output : null,
        cost: typeof usage?.cost?.total === "number" ? usage.cost.total : null,
      };

      emit(s, record);
      s.turnStartedAt = null;
    }),
  );

  pi.on("message_start", (event) =>
    safe("message_start", () => {
      const s = state;
      if (!s?.session) return;
      const assistant = assistantLike(event.message);
      if (s.config.liveText && assistant) {
        s.merge.noteMessage(s.session.sessionId, s.runSeq, s.turnIndex, event.message, nowIso());
      }
      pushEvent(s, "message", "message_start", {
        role: assistant ? "assistant" : (event.message as { role?: unknown })?.role ?? "unknown",
        turnIndex: s.turnIndex,
      }, { runSeq: s.runSeq, turnIndex: s.turnIndex });
    }),
  );

  pi.on("message_update", (event) =>
    safe("message_update", () => {
      const s = state;
      if (!s?.session) return;
      if (!s.config.liveText) return; // 开关关闭：只处理 message_start 与 turn_end（PRD §7.3）
      const assistant = assistantLike(event.message);
      if (!assistant) return;
      s.merge.noteMessage(s.session.sessionId, s.runSeq, s.turnIndex, event.message, nowIso());
    }),
  );

  pi.on("tool_execution_start", (event) =>
    safe("tool_execution_start", () => {
      const s = state;
      if (!s?.session) return;
      const startedAt = nowIso();
      pushEvent(s, "tool", "tool_execution_start", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: capValue(event.args, Math.floor(s.config.maxRecordBytes / 4)).value,
        parentToolCallId: event.parentToolCallId ?? null,
      }, { runSeq: s.runSeq, turnIndex: s.turnIndex });
      emit(s, {
        kind: "tool_call",
        tool_call_id: event.toolCallId,
        session_id: s.session.sessionId,
        parent_tool_call_id: event.parentToolCallId ?? null,
        tool_name: event.toolName,
        args: capValue(event.args, s.config.maxRecordBytes).value,
        result: null,
        partial_result: null,
        is_error: false,
        duration_ms: null,
        started_at: startedAt,
        ended_at: null,
      });
    }),
  );

  pi.on("tool_execution_update", (event) =>
    safe("tool_execution_update", () => {
      const s = state;
      if (!s?.session) return;
      if (!s.config.liveText) return;
      s.merge.noteToolPartial(
        event.toolCallId,
        s.session.sessionId,
        event.toolName,
        capValue(event.partialResult, Math.floor(s.config.maxRecordBytes / 4)).value,
        nowIso(),
      );
    }),
  );

  pi.on("tool_execution_end", (event) =>
    safe("tool_execution_end", () => {
      const s = state;
      if (!s?.session) return;
      const partial = s.merge.consumeTool(event.toolCallId);
      const endedAt = nowIso();

      pushEvent(s, "tool", "tool_execution_end", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        durationMs: event.durationMs ?? null,
      }, { runSeq: s.runSeq, turnIndex: s.turnIndex });

      emit(s, {
        kind: "tool_call",
        tool_call_id: event.toolCallId,
        session_id: s.session.sessionId,
        parent_tool_call_id: event.parentToolCallId ?? null,
        tool_name: event.toolName,
        // 参数在 tool_execution_start 已写过；这里给 null，服务端 upsert 保留原值
        args: null,
        result: capValue(event.result, s.config.maxRecordBytes).value,
        partial_result: partial ? capValue(partial.partialResult, s.config.maxRecordBytes).value : null,
        is_error: event.isError === true,
        duration_ms: typeof event.durationMs === "number" ? event.durationMs : null,
        started_at: partial?.startedAt ?? null,
        ended_at: endedAt,
      });
    }),
  );

  pi.on("model_select", (event) =>
    safe("model_select", () => {
      if (!state) return;
      const model = event.model as unknown as { id?: unknown; name?: unknown } | undefined;
      const previous = event.previousModel as unknown as { id?: unknown } | undefined;
      pushEvent(state, "provider", "model_select", {
        model: typeof model?.id === "string" ? model.id : (model?.name ?? null),
        previousModel: typeof previous?.id === "string" ? previous.id : null,
        source: event.source,
      });
    }),
  );

  pi.on("thinking_level_select", (event) =>
    safe("thinking_level_select", () => {
      if (!state) return;
      pushEvent(state, "provider", "thinking_level_select", {
        level: event.level,
        previousLevel: event.previousLevel,
      });
    }),
  );

  pi.on("session_shutdown", async (event) => {
    const s = state;
    if (!s) return;
    try {
      safe("session_shutdown", () => {
        pushEvent(s, "session", "session_shutdown", {
          reason: event.reason,
          targetSessionFile: event.targetSessionFile ?? null,
        });
      });
      // 尽力把积压发完，最多等 3 秒；超时就放弃（不能拖住 Pi 退出）
      await flushWithin(s, 3000);
    } catch (error) {
      try {
        console.error(`[pi-observer] 退出收尾失败：${(error as Error).message}`);
      } catch {
        // 忽略
      }
    } finally {
      stopTimers(s);
      // 收尾后仍有剩的，说明服务端一直不可达。丢掉但必须说出来，不能假装没发生。
      if (s.queue.depth > 0) {
        try {
          console.error(
            `[pi-observer] 退出时仍有 ${s.queue.depth} 条未送达（服务端不可达？），本次会话丢弃 ${s.queue.droppedCount + s.rejectedByServer + s.queue.depth} 条`,
          );
        } catch {
          // 忽略
        }
      }
      s.queue.clear();
      s.merge.clear();
      state = null;
    }
  });
}
