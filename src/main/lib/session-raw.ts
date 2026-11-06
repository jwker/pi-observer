/**
 * 按条目 id 读一条原始 JSON。
 *
 * 解析会话时正文被截到 2 KB，原文没有留在内存里；
 * 行详情弹窗要显示完整原文，所以这里再扫一遍文件。
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface RawEntry {
  raw: Record<string, unknown>;
  /** 行号（从 0 开始） */
  line: number;
}

/** 读不到就返回 null */
export async function readEntryRaw(filePath: string, entryId: string): Promise<RawEntry | null> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = null;
        }
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (record.id === entryId) return { raw: record, line: index };
        }
      }
      index += 1;
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}
