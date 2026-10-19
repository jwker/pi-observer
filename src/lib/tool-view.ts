/** 工具视图的纯逻辑（PRD §11.2 视图三）；不依赖 React，可直接被 node --test 覆盖 */
import { previewJson } from "./format.ts";

export interface ToolStatusMeta {
  label: string;
  className: string;
  title: string;
}

export function toolStatusMeta(isError: number, durationMs: number | null): ToolStatusMeta {
  if (isError === 1) {
    return {
      label: "失败",
      className: "badge err",
      title: durationMs === null ? "工具返回错误" : `工具返回错误，耗时 ${durationMs} ms`,
    };
  }
  return {
    label: "成功",
    className: "badge ok",
    title: durationMs === null ? "工具成功返回" : `工具成功返回，耗时 ${durationMs} ms`,
  };
}

/** 列表里的参数摘要：能解析就按键值压成一行，不能就原样截断（不说“解析失败”这种噪音） */
export function toolArgSummary(preview: string | null, max = 120): string {
  if (preview === null || preview.trim() === "") return "（无参数）";
  try {
    const parsed = JSON.parse(preview) as unknown;
    return previewJson(parsed, max) ?? "（无参数）";
  } catch {
    const text = preview.replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
}

export interface ToolFilter {
  toolName: string;
  /** "all" 或 Turn 序号 */
  turn: string;
  errorsOnly: boolean;
}

export function filterToolCalls<T extends { tool_name: string; turn_index: number | null; is_error: number }>(
  rows: T[],
  filter: ToolFilter,
): T[] {
  return rows.filter((row) => {
    if (filter.toolName !== "all" && row.tool_name !== filter.toolName) return false;
    if (filter.turn !== "all" && String(row.turn_index) !== filter.turn) return false;
    if (filter.errorsOnly && row.is_error !== 1) return false;
    return true;
  });
}

/** 工具名选项：出现过的名字，按字典序；空列表返回空 */
export function toolNameOptions<T extends { tool_name: string }>(rows: T[]): string[] {
  return [...new Set(rows.map((row) => row.tool_name).filter((name) => name !== ""))].sort();
}

/** Turn 选项：出现过的非 null Turn，升序；默认只取最近 12 个，避免芯片排满一行 */
export function toolTurnOptions<T extends { turn_index: number | null }>(rows: T[], limit = 12): number[] {
  const turns = [...new Set(rows.map((row) => row.turn_index).filter((turn): turn is number => turn !== null))].sort(
    (a, b) => a - b,
  );
  return turns.slice(-limit);
}

export interface ToolResultText {
  kind: "text" | "json" | "empty";
  text: string;
  /** 非文本块（图片等）的说明；没有就为 null */
  note: string | null;
}

/**
 * 工具结果的可读文本。真实结果是 `{ role: "toolResult", content: [{type:"text",text}] }`
 * 这种形状；自定义工具也允许直接返回字符串或任意 JSON，所以三种都接住。
 */
export function toolResultText(result: unknown): ToolResultText {
  if (result === null || result === undefined) return { kind: "empty", text: "", note: null };

  if (typeof result === "string") {
    return result.trim() === "" ? { kind: "empty", text: "", note: null } : { kind: "text", text: result, note: null };
  }

  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const texts: string[] = [];
      const others = new Map<string, number>();
      for (const block of record.content) {
        if (typeof block === "object" && block !== null) {
          const item = block as Record<string, unknown>;
          if (item.type === "text" && typeof item.text === "string") {
            texts.push(item.text);
            continue;
          }
          const type = typeof item.type === "string" ? item.type : "unknown";
          others.set(type, (others.get(type) ?? 0) + 1);
        }
      }
      const note =
        others.size === 0
          ? null
          : [...others.entries()].map(([type, count]) => `${count} 个 ${type} 块`).join("、") + "（界面只显示文本）";
      if (texts.length === 0) return { kind: note === null ? "empty" : "json", text: "", note };
      return { kind: "text", text: texts.join(""), note };
    }
    return { kind: "json", text: safeJson(result), note: null };
  }

  return { kind: "text", text: String(result), note: null };
}

/** 参数 / 结果的展示文本：超过 maxChars 只给前段，避免把 512 KB 塞进 DOM */
export function clipForDisplay(value: unknown, maxChars = 64_000): { text: string; truncated: boolean } {
  const text = typeof value === "string" ? value : safeJson(value);
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n…[只显示前 ${maxChars} 个字符，完整内容在库里]`, truncated: true };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}
