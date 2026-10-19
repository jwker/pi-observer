/**
 * 会话文件（JSONL，v3）的解析与增量读取（PRD §9.2）。
 *
 * 这一层只管「把字节变成条目」，不碰数据库：M2-2 才是回填入库。
 * 真相源是 `~/.pi/agent/sessions/` 下的 JSONL，实时事件只做即时展示，所以这里的规则
 * 必须能容忍「Pi 正在写这个文件」。
 *
 * PRD §9.2 的五条规则逐条落在这里：
 *   1. 只消费以换行结尾的完整行，末尾残片留在缓冲区（按字节切，不按字符切，
 *      否则多字节字符被切断会产生乱码）。
 *   2. 每次读取前比较文件大小，变小即认为是整文件重写，从头重读。
 *   3. 用条目 `id` 去重，重写会让已消费的内容再出现一次。
 *   4. 解析失败的行跳过并记一条警告，不中断整个文件。
 *   5. 不加文件锁。
 *
 * 额外加了一层保险（比 PRD 多，但不违反任何一条）：记住已消费内容的末尾 512 字节
 * （「尾锚」），增量读之前先回读这一段比对。文件被重写时，这一段几乎必然对不上，
 * 于是同样从头重读。为什么不用「开头若干字节的指纹」：同一个会话被重写时头部
 * （id / cwd / timestamp）通常原样保留，看开头看不出来；而尾锚检测的是「我之前读到的东西
 * 还在不在原处」。正常追加写入不会改动已消费区域，所以不会误判。
 */
import { openSync, closeSync, fstatSync, readSync } from "node:fs";

/** 会话文件头部（首行的 `session` 条目） */
export interface SessionHeader {
  sessionId: string;
  version: number | null;
  cwd: string;
  timestamp: string | null;
  /** 分叉会话才有 */
  parentSession: string | null;
}

/** 一条已解析的条目 */
export interface JournalEntry {
  /** 条目 `id`；极少数类型可能没有，此时为 null（无法去重，见文件头注释） */
  entryId: string | null;
  parentId: string | null;
  timestamp: string | null;
  /** 条目类型：`message` / `model_change` / `compaction` / `custom` … */
  type: string;
  /** 原始 JSON 对象 */
  raw: Record<string, unknown>;
}

export interface JournalReadResult {
  ok: boolean;
  /** 读不到文件时的原因（`ok: false`） */
  error?: string;
  /** 本次读到的头部；增量读取且头部没再出现时为 null */
  header: SessionHeader | null;
  /** 本次新增的条目（已去重） */
  entries: JournalEntry[];
  /** 坏行等警告，交由上层记日志 */
  warnings: string[];
  /** 是否因为文件变小 / 指纹变化而从头重读 */
  restarted: boolean;
  /** 文件当前大小 */
  size: number;
  /** 本次实际消费的字节数 */
  bytesRead: number;
}

/** 只用到「看大小、按偏移读」两件事，方便在测试里替换掉真实文件系统 */
export interface JournalFs {
  sizeOf(path: string): number;
  readRange(path: string, offset: number, length: number): Buffer;
}

export const nodeJournalFs: JournalFs = {
  sizeOf(path) {
    return statSize(path);
  },
  readRange(path, offset, length) {
    if (length <= 0) return Buffer.alloc(0);
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const bytes = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, bytes);
    } finally {
      closeSync(fd);
    }
  },
};

function statSize(path: string): number {
  const fd = openSync(path, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

interface FileState {
  /** 已消费到的字节偏移 */
  offset: number;
  /** 上次看到的文件大小，用于规则 2 */
  lastSize: number;
  /** 已消费内容的末尾若干字节（尾锚），用于识别「没变小但被重写」 */
  tail: Buffer | null;
  /** 尚未以换行结尾的残片（规则 1） */
  buffer: Buffer;
  /** 已见过的条目 id（规则 3） */
  seenIds: Set<string>;
  /** 已消费的完整行数，用于警告里的行号 */
  lineNo: number;
}

const TAIL_BYTES = 512;

export interface JournalReader {
  /** 读一个文件；同一个 reader 上重复调用即为增量读 */
  read(path: string): JournalReadResult;
  /** 忘掉某个文件（或全部）的读取状态，下一次从头读 */
  reset(path?: string): void;
}

export function createJournalReader(fs: JournalFs = nodeJournalFs): JournalReader {
  const states = new Map<string, FileState>();

  function freshState(): FileState {
    return { offset: 0, lastSize: 0, tail: null, buffer: Buffer.alloc(0), seenIds: new Set(), lineNo: 0 };
  }

  function read(path: string): JournalReadResult {
    const result: JournalReadResult = {
      ok: false,
      header: null,
      entries: [],
      warnings: [],
      restarted: false,
      size: 0,
      bytesRead: 0,
    };

    let size: number;
    try {
      size = fs.sizeOf(path);
    } catch (error) {
      result.error = `读不到会话文件：${(error as Error).message}`;
      return result;
    }

    let state = states.get(path) ?? freshState();
    states.set(path, state);
    result.size = size;

    // 规则 2：变小说明整文件重写。再加尾锚校验，覆盖「没变小但被重写」（含截断到 0 后又写回）。
    let rewritten = state.lastSize > size;
    if (!rewritten && size > 0 && state.tail !== null) {
      rewritten = !tailStillThere(fs, path, state);
    }
    if (rewritten) {
      // 保留 seenIds：重写会把已消费的内容再写一遍，靠 id 去重（规则 3）
      const seen = state.seenIds;
      state = { ...freshState(), seenIds: seen };
      states.set(path, state);
      result.restarted = true;
    }

    if (size === 0) {
      state.lastSize = 0;
      result.ok = true;
      return result;
    }

    if (size > state.offset) {
      let chunk: Buffer;
      try {
        chunk = fs.readRange(path, state.offset, size - state.offset);
      } catch (error) {
        result.error = `读取会话文件失败：${(error as Error).message}`;
        return result;
      }
      state.offset += chunk.length;
      state.buffer = Buffer.concat([state.buffer, chunk]);
      state.tail = tailOf(state.tail, chunk);
      result.bytesRead = chunk.length;
    }

    state.lastSize = size;
    result.ok = true;

    // 规则 1：只消费完整行，残片留在缓冲区
    const lastNewline = state.buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) return result;
    const complete = state.buffer.subarray(0, lastNewline + 1).toString("utf8");
    state.buffer = Buffer.from(state.buffer.subarray(lastNewline + 1));

    for (const rawLine of complete.split("\n")) {
      if (rawLine === "") continue;
      state.lineNo += 1;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim() === "") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // 规则 4：跳过坏行，记警告，不中断
        result.warnings.push(`第 ${state.lineNo} 行不是合法 JSON（已跳过）：${(error as Error).message}`);
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        result.warnings.push(`第 ${state.lineNo} 行不是对象（已跳过）`);
        continue;
      }

      const record = parsed as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "(无 type)";

      if (type === "session") {
        // 头部每次出现都重新返回：增量读也要能拿到 cwd / version
        result.header = readHeader(record, path, state.lineNo, result.warnings);
        continue;
      }

      const entryId = typeof record.id === "string" ? record.id : null;
      if (entryId === null) {
        // 没有 id 就没法去重；如实返回，并在警告里说清楚
        result.warnings.push(`第 ${state.lineNo} 行（type=${type}）没有 id，无法去重`);
      } else {
        if (state.seenIds.has(entryId)) continue; // 规则 3
        state.seenIds.add(entryId);
      }

      result.entries.push({
        entryId,
        parentId: typeof record.parentId === "string" ? record.parentId : null,
        timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
        type,
        raw: record,
      });
    }

    if (state.buffer.length > 0) {
      result.warnings.push(`文件末尾有 ${state.buffer.length} 字节不完整片段，已留在缓冲区等下次`);
    }

    return result;
  }

  function reset(path?: string): void {
    if (path === undefined) states.clear();
    else states.delete(path);
  }

  return { read, reset };
}

export function readHeader(
  record: Record<string, unknown>,
  path: string,
  lineNo: number,
  warnings: string[],
): SessionHeader | null {
  const sessionId = typeof record.id === "string" ? record.id : null;
  const cwd = typeof record.cwd === "string" ? record.cwd : null;
  if (sessionId === null || cwd === null) {
    warnings.push(`第 ${lineNo} 行的 session 头部缺 id 或 cwd（已忽略）：${path}`);
    return null;
  }
  return {
    sessionId,
    version: typeof record.version === "number" ? record.version : null,
    cwd,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
    parentSession:
      typeof record.parentSession === "string"
        ? record.parentSession
        : typeof record.parent_session === "string"
          ? record.parent_session
          : null,
  };
}

/**
 * 已消费内容末尾的若干字节，作为「这段内容还在不在原处」的锚点。
 * 只保留末尾，内存占用与文件大小无关。
 */
function tailOf(previous: Buffer | null, chunk: Buffer): Buffer {
  const joined = previous === null ? chunk : Buffer.concat([previous, chunk]);
  return joined.length <= TAIL_BYTES ? Buffer.from(joined) : Buffer.from(joined.subarray(joined.length - TAIL_BYTES));
}

/**
 * 回读尾锚所在的那段字节，判断是否与上次读到的一致。
 *
 * 两种情况一律返回 true（当作没变）：
 *   - 读不回来（文件被删、权限变了）：不该因为一次 IO 抖动就把整个文件重读；
 *   - 短读（返回的字节数不足）：一次不完整的读说明不了问题，而且如果这里判「变了」，
 *     在持续短读的情况下会变成「重读 → 又短读 → 再重读」的死循环，永远读不完。
 * 代价是极端情况下漏判重写，但 PRD 规则 2 的大小比较仍在，且条目 id 去重兜底。
 */
function tailStillThere(fs: JournalFs, path: string, state: FileState): boolean {
  if (state.tail === null || state.tail.length === 0) return true;
  const start = state.offset - state.tail.length;
  if (start < 0) return true;
  try {
    const actual = fs.readRange(path, start, state.tail.length);
    if (actual.length !== state.tail.length) return true;
    return actual.equals(state.tail);
  } catch {
    return true;
  }
}

/**
 * 会话目录名到工作目录的「编码」规则（PRD §4.2）：
 * 去掉开头的路径分隔符，把 `/`、`\`、`:` 换成 `-`，再套一层 `--`。
 *
 * 只用于**已知 cwd 时反推目录名**（例如从事件里的 cwd 找文件）。
 * 反向解码不可靠（真实路径里的 `-` 与分隔符无法区分），所以 cwd 一律以文件头部为准。
 */
export function encodeSessionDirSegment(cwd: string): string {
  const trimmed = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${trimmed}--`;
}
