/**
 * 探针的发送器：批量推送 + 指数退避 + 退出前的收尾排空。
 *
 * 从 `ext/index.ts` 里抽出来单独成文件，是因为这里出过一个真实故障：
 * 服务端重启后探针仍处在退避窗口里，`session_shutdown` 的那次收尾 flush 被退避闸门挡住，
 * 整队积压被静默丢弃。逻辑放在闭包里没法写回归测试，抽出来才能测。
 */
import {
  PROBE_PROTOCOL_VERSION,
  PROBE_VERSION,
  type IngestBatch,
  type IngestRecord,
} from "../src/lib/protocol.ts";
import { backoffDelay, postBatch } from "./client.ts";
import type { BoundedQueue } from "./queue.ts";

/**
 * 毒批日志里的批次指纹：按顺序列出记录种类，并给出最大单条体积。
 * 服务端的错误信息里带 `records[N].xxx`，对着这个顺序就能定位到具体哪条。
 */
function describeBatch(records: IngestRecord[]): string {
  const kinds = records.map((record) => record.kind).join(",");
  let maxBytes = 0;
  for (const record of records) {
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(record) ?? "", "utf8");
    } catch {
      bytes = 0;
    }
    if (bytes > maxBytes) maxBytes = bytes;
  }
  return `[${kinds}] 最大单条 ${(maxBytes / 1024).toFixed(1)} KB`;
}

export interface FlushDeps {
  queue: BoundedQueue<IngestRecord>;
  /** 写入地址。每次发送时现取：看板换了端口以后不用重启 Pi */
  ingestUrl: () => string;
  /** 取令牌；服务端可能还没启动过，取不到就返回 null */
  token: () => string | null;
  /** 被服务端拒绝（毒批）而丢弃的条数 */
  rejectedCount: () => number;
  /** 服务端回了 401：清掉内存里缓存的令牌，下次重试重新读令牌文件 */
  onUnauthorized?: () => void;
  /**
   * 连不上（或被拒）时调用：让上层有机会重读配置文件、换个地址。
   * 返回 true 表示地址真的变了，退避重新开始，立刻用新地址再试一次。
   */
  onUnreachable?: () => boolean;
  maxBatchRecords: number;
  maxBatchBytes: number;
  /** 探针写正文文件的根目录；批次里报给服务端做一致性检查 */
  payloadRoot: () => string | null;
  log: (message: string) => void;
  now?: () => number;
  post?: typeof postBatch;
}

export interface FlushOptions {
  /** 绕过退避闸门，只给退出收尾用 */
  ignoreBackoff?: boolean;
  /** 单批 HTTP 超时 */
  timeoutMs?: number;
}

export interface Flusher {
  /** 尝试发一批；返回 true 表示队列有净减少 */
  flush(options?: FlushOptions): Promise<boolean>;
  /** 在预算内反复发，直到队列清空或时间用完；返回实际尝试轮数 */
  drainWithin(budgetMs: number): Promise<number>;
  nextAttemptAt(): number;
  attempt(): number;
  queueDepth(): number;
}

export function createFlusher(deps: FlushDeps): Flusher {
  const now = deps.now ?? (() => Date.now());
  const post = deps.post ?? postBatch;

  let flushing = false;
  let attempt = 0;
  let nextAttemptAt = 0;

  async function flush(options: FlushOptions = {}): Promise<boolean> {
    if (flushing) return false;
    if (!options.ignoreBackoff && now() < nextAttemptAt) return false;
    if (deps.queue.depth === 0) return false;

    const token = deps.token();
    if (!token) {
      // 服务端还没生成令牌文件：按退避重试，别空转
      const wait = backoffDelay(attempt);
      attempt += 1;
      nextAttemptAt = now() + wait;
      return false;
    }

    flushing = true;
    const records = deps.queue.takeWithin(deps.maxBatchRecords, deps.maxBatchBytes);

    try {
      const batch: IngestBatch = {
        protocol: PROBE_PROTOCOL_VERSION,
        probe_version: PROBE_VERSION,
        dropped_count: deps.queue.droppedCount + deps.rejectedCount(),
        queue_depth: deps.queue.depth,
        payload_root: deps.payloadRoot(),
        records,
      };

      const outcome = await post({ url: deps.ingestUrl(), token, batch, timeoutMs: options.timeoutMs });

      if (outcome.ok) {
        attempt = 0;
        nextAttemptAt = 0;
        return true;
      }

      if (outcome.retryable) {
        deps.queue.requeue(records);
        // 地址可能变了（桌面版换端口、服务重启后换了端口）：让上层重读配置文件。
        // 真变了就跳过退避，立刻用新地址再试——不然用户要等最多 15 秒才知道换地址了。
        const switched = deps.onUnreachable?.() ?? false;
        if (switched) {
          attempt = 0;
          nextAttemptAt = 0;
          deps.log(`看板地址已切换，立即用新地址重试`);
          return false;
        }
        // 注意顺序：先按「已有失败次数」取档位，再累加，
        // 否则第一次失败会直接跳到第二档（1s 变 2s）
        const wait = backoffDelay(attempt);
        attempt += 1;
        nextAttemptAt = now() + wait;
        if (outcome.status === 401) {
          // 令牌可能已被服务端重新生成（或探针指向了别的实例）：丢掉缓存的旧值，
          // 下一批重读令牌文件。仍然走退避档位，否则令牌真的不对时会每 300 ms 空转一次。
          deps.onUnauthorized?.();
          deps.log(`令牌校验失败，已清除缓存令牌，${wait}ms 后用重读的令牌重试：${outcome.reason}`);
        } else {
          deps.log(`推送失败，${wait}ms 后重试：${outcome.reason}`);
        }
        return false;
      }

      // 毒批（形状错、协议不匹配、这批太大）：重发不会成功，丢掉并计数。
      // 日志里带上记录种类与最大体积，否则只能看到「丢了 N 条」而不知道是哪条的问题。
      deps.log(`批次被拒绝，已丢弃 ${records.length} 条：${describeBatch(records)} ${outcome.reason}`);
      return true;
    } finally {
      flushing = false;
    }
  }

  async function drainWithin(budgetMs: number): Promise<number> {
    const deadline = now() + budgetMs;
    let rounds = 0;
    while (deps.queue.depth > 0 && now() < deadline) {
      const before = deps.queue.depth;
      await flush({ ignoreBackoff: true, timeoutMs: Math.max(500, deadline - now()) });
      rounds += 1;
      if (deps.queue.depth >= before) break; // 没有净减少，再试也没意义
    }
    return rounds;
  }

  return {
    flush,
    drainWithin,
    nextAttemptAt: () => nextAttemptAt,
    attempt: () => attempt,
    queueDepth: () => deps.queue.depth,
  };
}
