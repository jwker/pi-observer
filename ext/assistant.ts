/**
 * 防御式读取助手消息：只认运行时真实存在的字段，避免耦合 Pi 的内部类型。
 * 探针只用它取 stopReason / thinkingLevel / usage，不再从里面重建正文。
 */
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

export function assistantLike(message: unknown): AssistantLike | null {
  if (!isObject(message)) return null;
  if (message.role !== "assistant") return null;
  return message as AssistantLike;
}
