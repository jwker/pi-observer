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

export interface FlushDeps {
  queue: BoundedQueue<IngestRecord>;
  ingestUrl: string;
  /** 取令牌；服务端可能还没启动过，取不到就返回 null */
  token: () => string | null;
  /** 被服务端拒绝（毒批）而丢弃的条数 */
  rejectedCount: () => number;
  maxBatchRecords: number;
  maxBatchBytes: number;
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
        records,
      };

      const outcome = await post({ url: deps.ingestUrl, token, batch, timeoutMs: options.timeoutMs });

      if (outcome.ok) {
        attempt = 0;
        nextAttemptAt = 0;
        return true;
      }

      if (outcome.retryable) {
        deps.queue.requeue(records);
        // 注意顺序：先按「已有失败次数」取档位，再累加，
        // 否则第一次失败会直接跳到第二档（1s 变 2s）
        const wait = backoffDelay(attempt);
        attempt += 1;
        nextAttemptAt = now() + wait;
        deps.log(`推送失败，${wait}ms 后重试：${outcome.reason}`);
        return false;
      }

      // 毒批（形状错、超限、令牌不对）：重发不会成功，丢掉并计数
      deps.log(`批次被拒绝，已丢弃 ${records.length} 条：${outcome.reason}`);
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
