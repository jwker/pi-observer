/**
 * 会话文件（JSONL，v3）的解析、增量读取与回填入库（PRD §9.1 / §9.2）。
 *
 * 分两层：上半部分（`createJournalReader`）只管「把字节变成条目」，不碰数据库；
 * 下半部分（M2-2）把条目写进 `sessions` / `messages` / `turns` / `tool_calls`。
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
import { openSync, closeSync, fstatSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.ts";
import { type Db, getDb, withTx } from "./db.ts";
import { refreshSessionAggregates } from "./ingest.ts";
import { serializeCapped } from "./redact.ts";

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
  /** 该条目在本文件里的行号（1 起，含头部行）。重写后会从头重数 */
  lineNo: number;
  /** 原始 JSON 对象 */
  raw: Record<string, unknown>;
}

export interface JournalReadResult {
  ok: boolean;
  /** 读不到文件时的原因（`ok: false`） */
  error?: string;
  /** 本次读到的头部；增量读取且头部没再出现时为 null */
  header: SessionHeader | null;
  /**
   * 文件所属会话 id。头部出现过就是头部的 id；否则用本次进程里记住的值。
   * 重写（restarted）之后若还没重新读到头部，这里是 null——此时不要拿旧会话去写数据。
   */
  sessionId: string | null;
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

/** 只用到「看大小、按偏移读、看修改时间」三件事，方便在测试里替换掉真实文件系统 */
export interface JournalFs {
  sizeOf(path: string): number;
  readRange(path: string, offset: number, length: number): Buffer;
  /**
   * 修改时间（毫秒）。可选：不实现就退化成「每次都重读」，
   * 只是慢一点，不会出错。回填用它判断文件有没有变。
   */
  mtimeMsOf?(path: string): number;
}

export const nodeJournalFs: JournalFs = {
  sizeOf(path) {
    return statSize(path);
  },
  mtimeMsOf(path) {
    return statSync(path).mtimeMs;
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
  /** 头部里读到的会话 id；重写后清空（新文件可能是别的会话） */
  sessionId: string | null;
}

const TAIL_BYTES = 512;

export interface ReadOptions {
  /**
   * 把「本次读到的全部条目」都返回，不按 id 过滤已见过的条目。
   *
   * 默认 false（规则 3 的去重），适合「只关心新数据」的实时场景。
   * 回填要 true：文件重写后行号会变，只有重新产出全部条目才能修正 `entry_index`；
   * 落库那一步用 `UNIQUE(session_id, entry_id)` 做真正的幂等，不依赖这里过滤。
   */
  emitAll?: boolean;
}

export interface JournalReader {
  /** 读一个文件；同一个 reader 上重复调用即为增量读 */
  read(path: string, options?: ReadOptions): JournalReadResult;
  /** 忘掉某个文件（或全部）的读取状态，下一次从头读 */
  reset(path?: string): void;
}

export function createJournalReader(fs: JournalFs = nodeJournalFs): JournalReader {
  const states = new Map<string, FileState>();

  function freshState(): FileState {
    return {
      offset: 0,
      lastSize: 0,
      tail: null,
      buffer: Buffer.alloc(0),
      seenIds: new Set(),
      lineNo: 0,
      sessionId: null,
    };
  }

  function read(path: string, options: ReadOptions = {}): JournalReadResult {
    const result: JournalReadResult = {
      ok: false,
      header: null,
      sessionId: null,
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
      result.sessionId = state.sessionId;
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
    result.sessionId = state.sessionId;

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
        if (result.header !== null) state.sessionId = result.header.sessionId;
        continue;
      }

      const entryId = typeof record.id === "string" ? record.id : null;
      if (entryId === null) {
        // 没有 id 就没法去重；如实返回，并在警告里说清楚
        result.warnings.push(`第 ${state.lineNo} 行（type=${type}）没有 id，无法去重`);
      } else {
        if (state.seenIds.has(entryId) && options.emitAll !== true) continue; // 规则 3
        state.seenIds.add(entryId);
      }

      result.entries.push({
        entryId,
        parentId: typeof record.parentId === "string" ? record.parentId : null,
        timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
        type,
        lineNo: state.lineNo,
        raw: record,
      });
    }

    if (state.buffer.length > 0) {
      result.warnings.push(`文件末尾有 ${state.buffer.length} 字节不完整片段，已留在缓冲区等下次`);
    }

    result.sessionId = state.sessionId;
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

// ─────────────────────────────────────────────────────────────────────────────
// 回填入库（PRD §9.1 / §9.2 / §9.3）
//
// 三条硬约束：
//   1. 与实时路径落同一行。持久键用实时探针也在用的那一套：会话 `session_id`、
//      条目 `entry_id`（实时里叫 `messageEntryId`）、工具 `tool_call_id`。
//      所以回填可以补实时丢的部分，且重复回填不会产生第二行。
//   2. 不猜。文件里没有的东西一律留空（`runs` 不建行、`state` 不推进、`name` 不写）。
//   3. 不改实时观察到的真值。`turns.run_seq` / `turn_index` 由探针观察得到，
//      回填只能给近似值，因此冲突时不覆盖；`sessions.state` 同理。
// ─────────────────────────────────────────────────────────────────────────────

/** `text` 列只放可读摘要（列表与消息树用），全文在 `payload` 里 */
const TEXT_MAX_BYTES = 2048;

/**
 * 回填给 `turns.run_seq` 的占位值。
 *
 * 一次 Pi 进程运行 = 一个 run，而 run 的边界只存在于实时事件里（进程启动/结束），
 * 会话文件里没有任何字段能反推它。所以回填把整个文件当作一个 run。
 * 同一个 `message_entry_id` 被实时写入时，探针的真实 `run_seq` 会覆盖这个占位值。
 */
const BACKFILL_RUN_SEQ = 1;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface BackfillContext {
  db: Db;
  /** 同一个 reader 上的多次 read 即为增量读；扫描与补读共用它 */
  reader: JournalReader;
  fs: JournalFs;
  /** 会话文件根目录（PRD §9.1） */
  sessionsDir: string;
  payloadMaxBytes: number;
  now: () => string;
  /** 每条警告都会回调一次，交给调用方记日志 */
  onWarning?: (message: string) => void;
}

export function createBackfillContext(overrides: Partial<BackfillContext> = {}): BackfillContext {
  const cfg = config();
  const fs = overrides.fs ?? nodeJournalFs;
  return {
    db: overrides.db ?? getDb(),
    reader: overrides.reader ?? readerFor(fs),
    fs,
    sessionsDir: overrides.sessionsDir ?? cfg.sessionsDir,
    payloadMaxBytes: overrides.payloadMaxBytes ?? cfg.payloadMaxBytes,
    now: overrides.now ?? (() => new Date().toISOString()),
    onWarning: overrides.onWarning,
  };
}

/**
 * 进程内按文件系统共享一个读取器。
 *
 * 为什么不是「每次调用新建一个」：读取器的状态（已消费偏移、尾锚、已见 id）是增量的前提。
 * 每次新建就等于每次都从头读，一个会话文件改一行也要把整份重新读一遍、重新 upsert 一遍。
 * 共享之后，启动扫描读完整文件，之后每次补读只消费新增的字节。
 *
 * 代价是这些状态会随进程常驻（每个文件一个 `Set<条目 id>`）。本机规模下可以忽略；
 * 真要省内存，可以在整份文件读完并落库后调用 `reader.reset(path)`。
 */
const sharedReaders = new Map<JournalFs, JournalReader>();

function readerFor(fs: JournalFs): JournalReader {
  let reader = sharedReaders.get(fs);
  if (reader === undefined) {
    reader = createJournalReader(fs);
    sharedReaders.set(fs, reader);
  }
  return reader;
}

export interface BackfillFileResult {
  path: string;
  /** 头部声明的会话 id；重写后还没读到新头部时为 null */
  sessionId: string | null;
  /** 文件大小与修改时间都没变，本次没有读 */
  skipped: boolean;
  /** 本次产出的条目数（含重写后重读的旧条目，落库由唯一键去重） */
  entries: number;
  warnings: string[];
}

export interface BackfillScanResult {
  root: string;
  /** 扫到的 `.jsonl` 文件数 */
  files: number;
  skipped: number;
  /** 有内容写入的文件数 */
  changed: number;
  entries: number;
  sessionIds: string[];
  warnings: string[];
  tookMs: number;
}

interface JsonlFileRow {
  path: string;
  session_id: string | null;
  size: number;
  mtime_ms: number;
  entry_count: number;
}

/** 文件大小 + 修改时间；读不到返回 null */
function fingerprint(fs: JournalFs, path: string): { size: number; mtime: number } | null {
  try {
    return { size: fs.sizeOf(path), mtime: fs.mtimeMsOf ? fs.mtimeMsOf(path) : -1 };
  } catch {
    return null;
  }
}

/**
 * 读一个会话文件并把结果写进库（PRD §9.1）。
 *
 * 幂等：同一个文件读两次不会多出行。文件没变时直接跳过（靠 `jsonl_files` 里的
 * 大小 + 修改时间判断，省掉启动时把全部历史重读一遍）。
 */
export function backfillFile(path: string, ctx: BackfillContext): BackfillFileResult {
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    ctx.onWarning?.(message);
  };

  const previous = ctx.db
    .prepare("SELECT path, session_id, size, mtime_ms, entry_count FROM jsonl_files WHERE path = ?")
    .get(path) as JsonlFileRow | undefined;
  const before = fingerprint(ctx.fs, path);

  // 大小与修改时间都对得上就认为没变。`mtime >= 0` 是「文件系统提供了修改时间」的前提：
  // 拿不到修改时间（比如测试里的简化 fs）就一律重读，慢一点但不会漏。
  if (
    previous !== undefined &&
    before !== null &&
    before.mtime >= 0 &&
    before.size === previous.size &&
    before.mtime === previous.mtime_ms
  ) {
    return { path, sessionId: previous.session_id, skipped: true, entries: 0, warnings };
  }

  const result = ctx.reader.read(path, { emitAll: true });
  for (const warning of result.warnings) warn(warning);
  if (!result.ok) {
    warn(result.error ?? `读不到会话文件：${path}`);
    return { path, sessionId: null, skipped: false, entries: 0, warnings };
  }

  const sessionId = result.sessionId;
  if (sessionId === null) {
    // 整文件重写之后还没重新读到头部，说明这个文件现在属于谁还没确定；下一轮再写。
    warn(`还没读到会话头部，本轮不写库：${path}`);
    return { path, sessionId: null, skipped: false, entries: 0, warnings };
  }

  const known = ctx.db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId);
  if (result.header === null && known === undefined) {
    warn(`库里没有会话 ${sessionId}，而本轮没读到头部，本轮不写库：${path}`);
    return { path, sessionId, skipped: false, entries: 0, warnings };
  }

  if (result.entries.length > 0 || result.header !== null) {
    writeEntries(
      ctx,
      {
        path,
        sessionId,
        header: result.header,
        entries: result.entries,
      },
      warn,
    );
  }

  // 进度只认「读之前」看到的大小与修改时间：这样记录的大小一定不超过真正消费掉的字节，
  // 文件在读取期间又长了的话，下一轮大小对不上会重读，不会漏数据。
  const after = before ?? { size: result.size, mtime: -1 };
  const entryCount = (
    ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId) as { n: number }
  ).n;
  ctx.db
    .prepare(
      `INSERT INTO jsonl_files (path, session_id, size, mtime_ms, entry_count, last_read_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         session_id = COALESCE(excluded.session_id, jsonl_files.session_id),
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         entry_count = excluded.entry_count,
         last_read_at = excluded.last_read_at`,
    )
    .run(path, sessionId, after.size, after.mtime, entryCount, ctx.now());

  return { path, sessionId, skipped: false, entries: result.entries.length, warnings };
}

interface WriteInput {
  path: string;
  sessionId: string;
  header: SessionHeader | null;
  entries: JournalEntry[];
}

/** 一个文件的条目 → 一个事务里的五张表 */
function writeEntries(ctx: BackfillContext, input: WriteInput, warn: (message: string) => void): void {
  const { sessionId, entries } = input;
  const db = ctx.db;
  const maxPayload = ctx.payloadMaxBytes;
  const jsonOrNull = (value: unknown): string | null =>
    value === null || value === undefined ? null : serializeCapped(value, maxPayload).json;

  const upsertSession = db.prepare(`
    INSERT INTO sessions (
      session_id, cwd, file_path, parent_session, version, name,
      started_at, last_activity_at, state, source
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 'idle', 'backfill')
    ON CONFLICT(session_id) DO UPDATE SET
      cwd = CASE WHEN excluded.cwd <> '' THEN excluded.cwd ELSE sessions.cwd END,
      file_path = COALESCE(excluded.file_path, sessions.file_path),
      parent_session = COALESCE(excluded.parent_session, sessions.parent_session),
      version = COALESCE(excluded.version, sessions.version),
      started_at = COALESCE(sessions.started_at, excluded.started_at),
      -- 已经有实时数据的会话，回填之后就是两个来源拼起来的（PRD §9.3）
      source = CASE WHEN sessions.source = 'backfill' THEN 'backfill' ELSE 'merged' END
  `);

  const upsertMessage = db.prepare(`
    INSERT INTO messages (session_id, entry_id, parent_id, kind, role, timestamp, entry_index, text, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, entry_id) DO UPDATE SET
      parent_id = COALESCE(excluded.parent_id, messages.parent_id),
      kind = excluded.kind,
      role = COALESCE(excluded.role, messages.role),
      timestamp = COALESCE(excluded.timestamp, messages.timestamp),
      entry_index = excluded.entry_index,
      text = COALESCE(excluded.text, messages.text),
      payload = COALESCE(excluded.payload, messages.payload)
  `);

  const upsertTurn = db.prepare(`
    INSERT INTO turns (
      session_id, run_seq, turn_index, message_entry_id, started_at, ended_at,
      stop_reason, thinking_level, assistant_message, tool_results, tokens_in, tokens_out, cost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_entry_id) DO UPDATE SET
      started_at = COALESCE(excluded.started_at, turns.started_at),
      ended_at = COALESCE(excluded.ended_at, turns.ended_at),
      stop_reason = COALESCE(excluded.stop_reason, turns.stop_reason),
      thinking_level = COALESCE(excluded.thinking_level, turns.thinking_level),
      assistant_message = COALESCE(excluded.assistant_message, turns.assistant_message),
      tool_results = COALESCE(excluded.tool_results, turns.tool_results),
      tokens_in = COALESCE(excluded.tokens_in, turns.tokens_in),
      tokens_out = COALESCE(excluded.tokens_out, turns.tokens_out),
      cost = COALESCE(excluded.cost, turns.cost)
  `);

  const upsertTool = db.prepare(`
    INSERT INTO tool_calls (
      tool_call_id, session_id, parent_tool_call_id, tool_name, args, result,
      partial_result, is_error, duration_ms, started_at, ended_at
    ) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(tool_call_id) DO UPDATE SET
      tool_name = CASE WHEN excluded.tool_name <> '' THEN excluded.tool_name ELSE tool_calls.tool_name END,
      args = COALESCE(excluded.args, tool_calls.args),
      result = COALESCE(excluded.result, tool_calls.result),
      -- 只置位不清零：文件里没有结果时别把实时已经知道的「出错」擦掉
      is_error = CASE WHEN excluded.is_error = 1 THEN 1 ELSE tool_calls.is_error END,
      duration_ms = COALESCE(excluded.duration_ms, tool_calls.duration_ms),
      started_at = COALESCE(excluded.started_at, tool_calls.started_at),
      ended_at = COALESCE(excluded.ended_at, tool_calls.ended_at)
  `);

  const turnOrdinal = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
     WHERE session_id = ? AND kind = 'message' AND role = 'assistant' AND entry_index < ?
  `);

  // 助手条目的 toolResult 子条目（parentId 指回它）。预先按 parentId 归组，
  // 这样写 turn 时就能一并填 tool_results 与 ended_at，不用来回扫。
  const resultsByParent = new Map<string, Array<{ toolCallId: string | null; isError: boolean; timestamp: string | null }>>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.parentId === null || !isObj(entry.raw.message)) continue;
    const message = entry.raw.message;
    if (message.role !== "toolResult") continue;
    const list = resultsByParent.get(entry.parentId) ?? [];
    list.push({
      toolCallId: strOf(message.toolCallId),
      isError: message.isError === true,
      timestamp: entry.timestamp,
    });
    resultsByParent.set(entry.parentId, list);
  }

  withTx(db, () => {
    const header = input.header;
    if (header !== null) {
      upsertSession.run(
        sessionId,
        header.cwd,
        input.path,
        header.parentSession,
        header.version,
        header.timestamp,
      );
    }

    let previousTimestamp: string | null = null;
    for (const entry of entries) {
      const raw = entry.raw;
      const kind = entry.type;
      const facts = factsOf(raw, kind);
      // 没有 id 的条目（极少数）无法按 id 去重，用行号当键：同一份文件每次都得到同一个键，
      // 所以重复回填仍然幂等，但文件被重写后这些行的身份会变。
      const entryId = entry.entryId ?? `#line:${entry.lineNo}`;
      upsertMessage.run(
        sessionId,
        entryId,
        entry.parentId,
        kind,
        facts.role,
        entry.timestamp,
        entry.lineNo,
        facts.text,
        serializeCapped(raw, maxPayload).json,
      );

      if (kind === "message" && facts.role === "assistant" && isObj(raw.message)) {
        const message = raw.message;
        const usage = isObj(message.usage) ? message.usage : null;
        const cost = usage !== null && isObj(usage.cost) ? usage.cost : null;
        const children = resultsByParent.get(entryId) ?? [];
        const ordinal = (turnOrdinal.get(sessionId, entry.lineNo) as { n: number }).n;
        // 起止时间只能近似：文件里没有「这一轮什么时候开始」。用上一条（通常是用户消息）
        // 的时间当开始，助手条目与工具结果里最晚的时间当结束。
        const startedAt = previousTimestamp ?? entry.timestamp;
        const endedAt = latestTimestamp([entry.timestamp, ...children.map((child) => child.timestamp)]);
        upsertTurn.run(
          sessionId,
          BACKFILL_RUN_SEQ,
          ordinal,
          entryId,
          startedAt,
          endedAt,
          strOf(message.stopReason),
          strOf(message.thinkingLevel),
          jsonOrNull(message),
          jsonOrNull(children.map((child) => ({ toolCallId: child.toolCallId, isError: child.isError }))),
          numOf(usage?.input),
          numOf(usage?.output),
          cost === null ? null : numOf(cost.total),
        );

        for (const call of toolCallsOf(message)) {
          upsertTool.run(call.id, sessionId, call.name, jsonOrNull(call.arguments), null, 0, null, entry.timestamp, null);
        }
      }

      if (kind === "message" && facts.role === "toolResult" && isObj(raw.message)) {
        const message = raw.message;
        const id = strOf(message.toolCallId);
        if (id === null) {
          warn(`第 ${entry.lineNo} 行的工具结果没有 toolCallId，无法入库：${input.path}`);
        } else {
          upsertTool.run(
            id,
            sessionId,
            strOf(message.toolName) ?? "",
            null,
            jsonOrNull(message),
            message.isError === true ? 1 : 0,
            numOf(message.durationMs),
            null,
            entry.timestamp,
          );
        }
      }

      previousTimestamp = entry.timestamp;
    }

    // 计数与 token 成本走与实时路径同一份聚合；缓存读写只在这里补，
    // 因为要从 payload 里 `json_extract`，放进每批都跑的聚合里代价太大。
    refreshSessionAggregates(db, sessionId);
    db.prepare(
      `UPDATE sessions SET
         cache_read = COALESCE((SELECT SUM(json_extract(payload, '$.message.usage.cacheRead'))
                                  FROM messages WHERE session_id = ? AND kind = 'message'), 0),
         cache_write = COALESCE((SELECT SUM(json_extract(payload, '$.message.usage.cacheWrite'))
                                   FROM messages WHERE session_id = ? AND kind = 'message'), 0)
       WHERE session_id = ?`,
    ).run(sessionId, sessionId, sessionId);
  });
}

interface EntryFacts {
  role: string | null;
  /** 可读摘要：`message` 条目是正文，其他类型是一行说明；都截到 `TEXT_MAX_BYTES` */
  text: string | null;
}

function factsOf(raw: Obj, kind: string): EntryFacts {
  const message = isObj(raw.message) ? raw.message : null;
  const role = message === null ? null : strOf(message.role);
  if (kind !== "message") return { role: null, text: describeEntry(kind, raw) };
  const text = textOfContent(message?.content) ?? placeholderOfContent(message?.content) ?? systemSummary(message);
  return { role, text };
}

/** `message.content` 里的 text 部分拼起来；没有 text 部分（或只有空串）返回 null */
function textOfContent(content: unknown): string | null {
  if (typeof content === "string") return content === "" ? null : capText(content);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (isObj(item) && item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  const joined = parts.join("\n");
  return joined === "" ? null : capText(joined);
}

/**
 * 系统消息的正文不在 `content` 里（实测是个空串），而在 `sections.preamble`。
 * 这里只取一段摘要，完整内容仍在 payload 里。
 */
function systemSummary(message: Obj | null): string | null {
  if (message === null || message.role !== "system") return null;
  const sections = isObj(message.sections) ? message.sections : null;
  const preamble = sections === null ? null : snippet(strOf(sections.preamble));
  return preamble === null ? "[系统提示]" : `[系统提示] ${preamble}`;
}

/** 只有思考 / 工具调用的助手消息：给个能认出来的占位摘要 */
function placeholderOfContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  let thinking = false;
  const names: string[] = [];
  for (const item of content) {
    if (!isObj(item)) continue;
    if (item.type === "thinking") thinking = true;
    if (item.type === "toolCall" && typeof item.name === "string") names.push(item.name);
  }
  const bits: string[] = [];
  if (thinking) bits.push("[思考]");
  if (names.length > 0) bits.push(`[工具调用：${names.join(", ")}]`);
  return bits.length === 0 ? null : bits.join(" ");
}

/** 非 message 条目的一行说明；不认识的类型返回 null（前端只显示类型名） */
function describeEntry(kind: string, raw: Obj): string | null {
  switch (kind) {
    case "model_change":
      return `模型 → ${strOf(raw.modelId) ?? strOf(raw.model) ?? "?"}`;
    case "thinking_level_change":
      return `思考等级 → ${strOf(raw.thinkingLevel) ?? "?"}`;
    case "compaction":
      return snippet(strOf(raw.summary)) ?? "上下文压缩";
    case "branch_summary":
      return snippet(strOf(raw.summary)) ?? "分支摘要";
    case "context_edit":
      return snippet(strOf(raw.summary)) ?? "上下文编辑";
    case "label":
      return `标签：${strOf(raw.label) ?? strOf(raw.name) ?? "?"}`;
    case "session_info":
      return snippet(strOf(raw.name)) ?? "会话信息";
    case "usage":
      return "用量";
    case "custom":
    case "custom_message":
      return snippet(strOf(raw.text)) ?? snippet(strOf(raw.name)) ?? "自定义条目";
    default:
      return null;
  }
}

function snippet(text: string | null): string | null {
  if (text === null) return null;
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine === "") return null;
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 120)}…`;
}

/** 按字节截断到 `TEXT_MAX_BYTES`，末尾补省略号；不切断多字节字符 */
function capText(text: string): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= TEXT_MAX_BYTES) return text;
  const head = buffer.subarray(0, TEXT_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
  return `${head}…`;
}

/** 助手消息 content 里的工具调用（`{type:"toolCall", id, name, arguments}`） */
function toolCallsOf(message: Obj): Array<{ id: string; name: string; arguments: unknown }> {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
  for (const item of content) {
    if (!isObj(item) || item.type !== "toolCall") continue;
    const id = strOf(item.id);
    if (id === null) continue;
    calls.push({ id, name: strOf(item.name) ?? "", arguments: item.arguments });
  }
  return calls;
}

function latestTimestamp(values: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

/** 递归列出目录下的会话文件（跳过隐藏目录） */
function listSessionFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) listSessionFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/**
 * 扫描会话目录并回填（PRD §9.1：服务启动时一次）。
 * 已经入库且文件没变的不重读，所以重复调用代价很小。
 */
export function scanSessionsDir(ctx: BackfillContext = createBackfillContext(), root?: string): BackfillScanResult {
  const dir = root ?? ctx.sessionsDir;
  const started = Date.now();
  const summary: BackfillScanResult = {
    root: dir,
    files: 0,
    skipped: 0,
    changed: 0,
    entries: 0,
    sessionIds: [],
    warnings: [],
    tookMs: 0,
  };

  let paths: string[];
  try {
    paths = listSessionFiles(dir).sort();
  } catch (error) {
    summary.warnings.push(`读不到会话目录 ${dir}：${(error as Error).message}`);
    summary.tookMs = Date.now() - started;
    return summary;
  }

  for (const path of paths) {
    const one = backfillFile(path, ctx);
    summary.files += 1;
    if (one.skipped) summary.skipped += 1;
    else if (one.entries > 0) summary.changed += 1;
    summary.entries += one.entries;
    if (one.sessionId !== null && !summary.sessionIds.includes(one.sessionId)) summary.sessionIds.push(one.sessionId);
    summary.warnings.push(...one.warnings);
  }

  summary.tookMs = Date.now() - started;
  return summary;
}

/** 按会话 id 找文件：先看库里的 `file_path`，再按文件名的 `<时间戳>_<id>.jsonl` 找 */
export function findSessionFile(sessionId: string, ctx: BackfillContext): string | null {
  const row = ctx.db.prepare("SELECT file_path FROM sessions WHERE session_id = ?").get(sessionId) as
    | { file_path: string | null }
    | undefined;
  if (row?.file_path) {
    const found = fingerprint(ctx.fs, row.file_path);
    if (found !== null) return row.file_path;
  }

  const suffix = `_${sessionId}.jsonl`;
  try {
    for (const path of listSessionFiles(ctx.sessionsDir)) {
      if (path.endsWith(suffix)) return path;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 进会话页面时的补读（PRD §9.1「页面进入会话时若无记录则补读」）。
 * 文件没变时 `backfillFile` 会直接跳过，所以每次进页面都调用也不贵。
 * 返回 null 表示没找到这个会话的文件。
 */
export function ensureSessionBackfilled(
  sessionId: string,
  ctx: BackfillContext = createBackfillContext(),
): BackfillFileResult | null {
  const path = findSessionFile(sessionId, ctx);
  if (path === null) return null;
  return backfillFile(path, ctx);
}
