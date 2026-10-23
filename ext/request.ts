/**
 * 模型请求采集（PRD §4.4 / §8.2 / C5）。
 *
 * `before_provider_request` 只给 payload，`after_provider_response` 只给状态码与 headers，
 * 两者之间没有共享 ID，所以按「会话内顺序」配对（correlation = serial_assumed）。
 *
 * 三条约束：
 * 1. **只读**：不修改 event，也不返回替换 payload。
 * 2. **正文进文件**：请求体可能有几 MB，不随批次传输，也不截断。
 *    探针写成文件后批次里只带相对路径与字节数（见 `ext/payload-store.ts`）。
 * 3. **序号跨进程不重置**：同一个会话分多次 Pi 进程续跑时，`request_seq` 由调用方
 *    通过 `initialSeq` / `persistSeq` 持久化，否则新进程会从 1 开始覆盖旧记录。
 */
import type { RequestRecord } from "../src/lib/protocol.ts";
import type { PayloadStore, StoredPayload } from "./payload-store.ts";

export interface RequestMeta {
  provider: string | null;
  api: string | null;
  model: string | null;
  runSeq: number | null;
  turnIndex: number | null;
}

/** 把任意值序列化成 JSON 文本；失败时给一个占位，不抛错 */
export function serializePayload(value: unknown): string {
  try {
    const json = JSON.stringify(value ?? null);
    return typeof json === "string" ? json : "null";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export interface RequestTrackerOptions {
  sessionId: string;
  /** 正文存储；不传就不写文件（正文会丢掉） */
  store?: PayloadStore;
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
  private readonly store: PayloadStore | undefined;
  private readonly persistSeq: ((seq: number) => void) | undefined;
  private readonly now: () => string;
  private readonly log: ((message: string) => void) | undefined;
  private sequence: number;
  private pendingSeq: number | null = null;

  constructor(options: RequestTrackerOptions) {
    this.sessionId = options.sessionId;
    this.store = options.store;
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

    const stored: StoredPayload | null = this.store?.write("request", this.sessionId, String(this.sequence), payload) ?? null;
    this.pendingSeq = this.sequence;
    this.log?.(
      stored
        ? `请求 #${this.sequence}：${stored.bytes} 字节，已写入 ${stored.path}`
        : `请求 #${this.sequence}：正文没写成文件（${serializePayload(payload).length} 字节）`,
    );

    return {
      kind: "request",
      session_id: this.sessionId,
      request_seq: this.sequence,
      provider: meta.provider,
      api: meta.api,
      model: meta.model,
      payload_path: stored?.path ?? null,
      payload_bytes: stored?.bytes ?? null,
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

    return {
      kind: "request",
      session_id: this.sessionId,
      request_seq: seq,
      provider: null,
      api: null,
      model: null,
      payload_path: null,
      payload_bytes: null,
      status,
      response_headers: headers ?? null,
      correlation: "serial_assumed",
      created_at: this.now(),
      run_seq: null,
      turn_index: null,
    };
  }
}
