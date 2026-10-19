/**
 * 流式合并表（PRD §7.3 / D4）。
 *
 * `message_update` 约 105 次/秒（本机实测），逐条转发没意义：这里只保留最新快照与计数，
 * 每 500 ms 作为一条进度快照出队一次，`turn_end` 时出队最终消息并删除。
 * 工具的部分结果同理，按 `toolCallId` 合并。
 *
 * 纯内存、无定时器，可在 `node --test` 里直接跑。
 */
import { progressEventId, type ProgressRecord, type ToolCallRecord } from "../src/lib/protocol.ts";

export interface AssistantLike {
  content?: unknown;
  provider?: string;
  model?: string;
  api?: string;
  responseId?: string;
  stopReason?: string;
  thinkingLevel?: string;
  timestamp?: number;
  durationMs?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 防御式读取助手消息：只认运行时真实存在的字段，避免耦合 Pi 的内部类型 */
export function assistantLike(message: unknown): AssistantLike | null {
  if (!isObject(message)) return null;
  if (message.role !== "assistant") return null;
  return message as AssistantLike;
}

export interface TextParts {
  text: string;
  thinking: string;
  toolCalls: number;
}

/** 从消息 content 里抽出正文、思考与工具调用计数 */
export function extractParts(content: unknown): TextParts {
  if (typeof content === "string") return { text: content, thinking: "", toolCalls: 0 };
  if (!Array.isArray(content)) return { text: "", thinking: "", toolCalls: 0 };

  const texts: string[] = [];
  const thinkings: string[] = [];
  let toolCalls = 0;

  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") thinkings.push(block.thinking);
    else if (block.type === "toolCall") toolCalls += 1;
  }

  return { text: texts.join(""), thinking: thinkings.join(""), toolCalls };
}

export interface MessageSnapshot {
  sessionId: string;
  runSeq: number;
  turnIndex: number;
  text: string;
  thinking: string;
  updateCount: number;
  startedAt: string | null;
  bytes: number;
}

export interface ToolSnapshot {
  toolCallId: string;
  sessionId: string;
  toolName: string;
  partialResult: unknown;
  updateCount: number;
  startedAt: string | null;
}

export function messageKey(runSeq: number, turnIndex: number): string {
  return `${runSeq}:${turnIndex}`;
}

export class MergeTable {
  private messages = new Map<string, MessageSnapshot>();
  private tools = new Map<string, ToolSnapshot>();

  /** message_start / message_update：用最新快照覆盖，计数 +1 */
  noteMessage(
    sessionId: string,
    runSeq: number,
    turnIndex: number,
    message: unknown,
    now: string,
  ): MessageSnapshot {
    const parts = extractParts((message as AssistantLike | null)?.content);
    const key = messageKey(runSeq, turnIndex);
    const previous = this.messages.get(key);

    const snapshot: MessageSnapshot = {
      sessionId,
      runSeq,
      turnIndex,
      text: parts.text,
      thinking: parts.thinking,
      updateCount: (previous?.updateCount ?? 0) + 1,
      startedAt: previous?.startedAt ?? now,
      bytes: Buffer.byteLength(parts.text, "utf8"),
    };

    this.messages.set(key, snapshot);
    return snapshot;
  }

  noteToolPartial(
    toolCallId: string,
    sessionId: string,
    toolName: string,
    partialResult: unknown,
    now: string,
  ): void {
    const previous = this.tools.get(toolCallId);
    this.tools.set(toolCallId, {
      toolCallId,
      sessionId,
      toolName,
      partialResult,
      updateCount: (previous?.updateCount ?? 0) + 1,
      startedAt: previous?.startedAt ?? now,
    });
  }

  peekMessage(runSeq: number, turnIndex: number): MessageSnapshot | undefined {
    return this.messages.get(messageKey(runSeq, turnIndex));
  }

  /** turn_end：取出并删除，调用方负责把最终消息写进 turns 表 */
  consumeMessage(runSeq: number, turnIndex: number): MessageSnapshot | undefined {
    const key = messageKey(runSeq, turnIndex);
    const snapshot = this.messages.get(key);
    this.messages.delete(key);
    return snapshot;
  }

  consumeTool(toolCallId: string): ToolSnapshot | undefined {
    const snapshot = this.tools.get(toolCallId);
    this.tools.delete(toolCallId);
    return snapshot;
  }

  /** 每 500 ms 出队一次进度快照（PRD §7.3） */
  drainProgress(): ProgressRecord[] {
    const records: ProgressRecord[] = [];
    for (const snapshot of this.messages.values()) {
      records.push({
        kind: "progress",
        session_id: snapshot.sessionId,
        run_seq: snapshot.runSeq,
        turn_index: snapshot.turnIndex,
        text: snapshot.text,
        update_count: snapshot.updateCount,
        started_at: snapshot.startedAt,
      });
    }
    return records;
  }

  /** 工具的部分结果也随进度一起出队，服务端按 toolCallId upsert 同一行 */
  drainToolPartials(): ToolCallRecord[] {
    const records: ToolCallRecord[] = [];
    for (const snapshot of this.tools.values()) {
      records.push({
        kind: "tool_call",
        tool_call_id: snapshot.toolCallId,
        session_id: snapshot.sessionId,
        parent_tool_call_id: null,
        tool_name: snapshot.toolName,
        args: null,
        result: null,
        partial_result: snapshot.partialResult,
        is_error: false,
        duration_ms: null,
        started_at: snapshot.startedAt,
        ended_at: null,
      });
    }
    return records;
  }

  get messageCount(): number {
    return this.messages.size;
  }

  get toolCount(): number {
    return this.tools.size;
  }

  clear(): void {
    this.messages.clear();
    this.tools.clear();
  }
}

export { progressEventId };
