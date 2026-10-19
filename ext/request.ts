/**
 * 模型请求采集（PRD §4.4 / §8.2 / C5）。
 *
 * `before_provider_request` 只给 payload，`after_provider_response` 只给状态码与 headers，
 * 两者之间没有共享 ID，所以按「会话内顺序」配对（`correlation = serial_assumed`）。
 *
 * 三条约束：
 * 1. **只读**：不修改 event，也不返回替换 payload。
 * 2. **先脱敏再截断**：`payload_bytes` 记的是脱敏前的原始字节数；超过上限时存一个
 *    合法 JSON 标记（带前 4 KB 预览），而不是切断字符串。
 * 3. **序号跨进程不重置**：同一个会话分多次 Pi 进程续跑时，`request_seq` 由调用方
 *    通过 `initialSeq` / `persistSeq` 持久化，否则新进程会从 1 开始覆盖旧记录。
 */
import { redact } from "../src/lib/redact.ts";
import type { RequestRecord } from "../src/lib/protocol.ts";
import { capText } from "./limit.ts";

/** 截断时保留的 JSON 预览字节数（只用于人看，不参与 payload_bytes） */
const PREVIEW_BYTES = 4096;

export interface RequestMeta {
  provider: string | null;
  api: string | null;
  model: string | null;
  runSeq: number | null;
  turnIndex: number | null;
}

export interface PreparedRequestValue {
  /** 脱敏后的值；超限时是合法 JSON 标记 */
  value: unknown;
  /** 脱敏前的原始序列化字节数 */
  originalBytes: number;
  /** 脱敏后的序列化字节数（截断前） */
  storedBytes: number;
  truncated: boolean;
  /** 被脱敏替换的字段路径 */
  removed: string[];
}

function trySerialize(value: unknown): { json: string; ok: boolean } {
  try {
    const json = JSON.stringify(value);
    return { json: typeof json === "string" ? json : "null", ok: true };
  } catch {
    return { json: JSON.stringify({ unserializable: true }), ok: false };
  }
}

export function prepareRequestValue(input: unknown, maxBytes: number): PreparedRequestValue {
  const original = trySerialize(input);
  const originalBytes = original.ok ? Buffer.byteLength(original.json, "utf8") : 0;

  let removed: string[] = [];
  let redacted: unknown;
  try {
    const result = redact(input);
    redacted = result.value;
    removed = result.removed;
  } catch {
    // 循环引用等异常形状：不把原始内容写进库，也不让 handler 抛错
    return {
      value: { unserializable: true, original_bytes: originalBytes },
      originalBytes,
      storedBytes: 0,
      truncated: true,
      removed,
    };
  }

  const serialized = trySerialize(redacted);
  const json = serialized.json;
  const storedBytes = serialized.ok ? Buffer.byteLength(json, "utf8") : 0;
  if (storedBytes <= maxBytes) {
    return { value: redacted, originalBytes, storedBytes, truncated: false, removed };
  }

  return {
    value: {
      truncated: true,
      bytes: storedBytes,
      original_bytes: originalBytes,
      head: capText(json, PREVIEW_BYTES),
    },
    originalBytes,
    storedBytes,
    truncated: true,
    removed,
  };
}

export interface RequestTrackerOptions {
  sessionId: string;
  maxBytes: number;
  /** 从持久游标读到的上一个序号；新会话为 0 */
  initialSeq?: number;
  /** 每分配一个序号就调用一次，调用方负责持久化 */
  persistSeq?: (seq: number) => void;
  now?: () => string;
  log?: (message: string) => void;
}

/**
 * 请求序号与请求/响应对应关系的纯逻辑部分（不碰文件、不碰队列，可在单测里直接跑）。
 *
 * pending 只保留一个序号：Pi 的请求是串行的，前一个响应没到达不会开始下一个。
 * 因此新的 `before_provider_request` 到来时，旧的未配对请求（典型是用户中断、没有响应）
 * 不会再收到响应，直接放弃配对——否则下一次响应会被错记到旧请求上。
 * 没有 pending 的响应（例如探针启动前就发出的请求）返回 null，由调用方如实记一条事件，
 * 不凭空造一条没有 payload 的请求记录。
 */
export class RequestTracker {
  readonly sessionId: string;
  private readonly maxBytes: number;
  private readonly persistSeq: ((seq: number) => void) | undefined;
  private readonly now: () => string;
  private readonly log: ((message: string) => void) | undefined;
  private sequence: number;
  private pendingSeq: number | null = null;

  constructor(options: RequestTrackerOptions) {
    this.sessionId = options.sessionId;
    this.maxBytes = options.maxBytes;
    this.sequence = options.initialSeq ?? 0;
    this.persistSeq = options.persistSeq;
    this.now = options.now ?? (() => new Date().toISOString());
    this.log = options.log;
  }

  currentSeq(): number {
    return this.sequence;
  }

  pendingCount(): number {
    return this.pendingSeq === null ? 0 : 1;
  }

  start(payload: unknown, meta: RequestMeta): RequestRecord {
    if (this.pendingSeq !== null) {
      this.log?.(`请求 #${this.pendingSeq} 没有收到响应（中断或失败），放弃配对`);
      this.pendingSeq = null;
    }
    this.sequence += 1;
    try {
      this.persistSeq?.(this.sequence);
    } catch {
      // 游标写不了也要继续采集；碰撞风险由调用方在日志里说明
    }

    const prepared = prepareRequestValue(payload, this.maxBytes);
    this.pendingSeq = this.sequence;
    this.log?.(
      `请求 #${this.sequence}：原始 ${prepared.originalBytes} 字节，脱敏 ${prepared.removed.length} 处，存 ${prepared.storedBytes} 字节${prepared.truncated ? "（已截断）" : ""}`,
    );

    return {
      kind: "request",
      session_id: this.sessionId,
      request_seq: this.sequence,
      provider: meta.provider,
      api: meta.api,
      model: meta.model,
      payload: prepared.value,
      payload_bytes: prepared.originalBytes,
      payload_truncated: prepared.truncated,
      status: null,
      response_headers: null,
      correlation: "serial_assumed",
      created_at: this.now(),
      run_seq: meta.runSeq,
      turn_index: meta.turnIndex,
    };
  }

  response(status: number | null, headers: unknown): RequestRecord | null {
    const seq = this.pendingSeq;
    if (seq === null) return null;
    this.pendingSeq = null;

    const prepared = prepareRequestValue(headers ?? {}, this.maxBytes);
    return {
      kind: "request",
      session_id: this.sessionId,
      request_seq: seq,
      provider: null,
      api: null,
      model: null,
      payload: null,
      payload_bytes: null,
      payload_truncated: null,
      status,
      response_headers: prepared.value,
      correlation: "serial_assumed",
      created_at: this.now(),
      run_seq: null,
      turn_index: null,
    };
  }
}
