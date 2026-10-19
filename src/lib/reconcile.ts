/**
 * 对账与会话状态推进（PRD §9.3 / §11.1）。
 *
 * 两件事：
 *
 *   1. **对账**：`agent_settled` 之后 3 秒，把会话文件重新读一遍——Pi 在这一轮结束时才把
 *      条目写完，实时事件里可能缺最后几条。补齐后写 `sessions.last_reconciled_at` 并广播
 *      `session.updated`（带 `reconciled: true`，页面据此重读消息树）。回填本身会把
 *      `source` 从 `live` 置成 `merged`（见 `backfill.ts`）。
 *
 *   2. **状态推进**：`session_shutdown` 到达时把会话标成 `ended`。`active` / `idle` 不用
 *      这里管——探针的 `session` 记录在 `agent_start` / `agent_settled` 时就带上了，
 *      服务端不做「多久没事件就推定空闲」那种猜测。
 *
 * 定时器不 `unref` 会拖住进程退出，所以都加上了；进程退出时丢掉的待对账会话，
 * 下次启动的扫描会重新读一遍文件，不会漏。
 */
import { createBackfillContext, ensureSessionBackfilled, type BackfillContext } from "./backfill.ts";
import { getDb, type Db } from "./db.ts";
import { log } from "./log.ts";
import type { IngestRecord } from "./protocol.ts";
import { broadcast } from "./sse.ts";

/** PRD §9.3：agent_settled 之后 3 秒再读，等 Pi 把这一轮的条目写完 */
export const RECONCILE_DELAY_MS = 3_000;

export interface SettleSignals {
  /** 本轮跑完了（`agent_settled`）的会话 */
  settled: string[];
  /** 会话关闭了（`session_shutdown`）的会话 */
  shutdown: string[];
}

/** 从一批记录里找出要推进状态、要安排对账的会话（去重，保持出现顺序） */
export function settleSignals(records: IngestRecord[]): SettleSignals {
  const settled = new Set<string>();
  const shutdown = new Set<string>();
  for (const record of records) {
    if (record.kind !== "event") continue;
    if (record.layer === "agent" && record.event_type === "agent_settled") settled.add(record.session_id);
    else if (record.layer === "session" && record.event_type === "session_shutdown") shutdown.add(record.session_id);
  }
  return { settled: [...settled], shutdown: [...shutdown] };
}

export interface ReconcileOutcome {
  session_id: string;
  /** 找到并读了会话文件；false 表示这个会话没有文件（例如只在探针里出现过的测试会话） */
  found: boolean;
  /** 本轮读出的条目数（文件没变、或没有新增内容时为 0） */
  entries: number;
  /** 写进 `sessions.last_reconciled_at` 的时间；没找到文件时为 null */
  reconciled_at: string | null;
}

/**
 * 对账一次：补读文件 → 记 `last_reconciled_at` → 广播。
 *
 * 文件没变时 `ensureSessionBackfilled` 只做两次 stat，`entries` 为 0，但仍然算「对过账」：
 * 我们确实去核对过了，记的是核对时间，不是「补了多少条」。
 */
export function reconcileSession(sessionId: string, ctx: BackfillContext = createBackfillContext()): ReconcileOutcome {
  const read = ensureSessionBackfilled(sessionId, ctx);
  const reconciledAt = read === null ? null : ctx.now();

  if (reconciledAt !== null) {
    ctx.db
      .prepare("UPDATE sessions SET last_reconciled_at = ? WHERE session_id = ?")
      .run(reconciledAt, sessionId);
  }

  const outcome: ReconcileOutcome = {
    session_id: sessionId,
    found: read !== null,
    entries: read?.entries ?? 0,
    reconciled_at: reconciledAt,
  };

  // 带上 reconciled：只有真的读了文件才让页面去重拉消息树，否则每次 settle 都白拉一遍
  broadcast("session.updated", { session_id: sessionId, reconciled: outcome.found });

  log(read === null ? "warn" : "info", "reconcile", read === null ? "没有会话文件，跳过对账" : "已对账", {
    session_id: sessionId,
    file: read?.path ?? null,
    entries: outcome.entries,
    skipped: read?.skipped ?? null,
    warnings: read?.warnings.length ?? 0,
  });

  return outcome;
}

/** 把会话推进到 ended（幂等）；返回是否真的改了 */
export function markSessionEnded(sessionId: string, db: Db = getDb()): boolean {
  const result = db.prepare("UPDATE sessions SET state = 'ended' WHERE session_id = ? AND state <> 'ended'").run(sessionId);
  return Number(result.changes) > 0;
}

/** 同一会话只留一个定时器；新的会重置计时，免得一轮里多次 settle 叠出好几次对账 */
const pending = new Map<string, NodeJS.Timeout>();

export function scheduleReconcile(sessionId: string, delayMs = RECONCILE_DELAY_MS): void {
  const existing = pending.get(sessionId);
  if (existing !== undefined) clearTimeout(existing);

  const timer = setTimeout(() => {
    pending.delete(sessionId);
    try {
      reconcileSession(sessionId);
    } catch (error) {
      log("warn", "reconcile", "对账失败", { session_id: sessionId, error: (error as Error).message });
    }
  }, delayMs);
  timer.unref();
  pending.set(sessionId, timer);
}

/** 还有几个会话在等对账（排查与验收用） */
export function pendingReconcileCount(): number {
  return pending.size;
}

/**
 * `POST /api/ingest` 落库之后调用：关闭的会话标 ended，跑完 / 关闭的会话安排对账。
 * 放在这里而不是 `applyBatch` 里，是为了让 ingest 保持「只写库、不排定时器」。
 *
 * `options` 只给测试用：注入临时库与一个同步的调度函数，避免真的等 3 秒、也避免写真实库。
 */
export function afterIngest(
  records: IngestRecord[],
  options: { db?: Db; schedule?: (sessionId: string) => void } = {},
): { ended: string[]; scheduled: string[] } {
  const { settled, shutdown } = settleSignals(records);
  const db = options.db ?? getDb();
  const schedule = options.schedule ?? ((sessionId: string) => scheduleReconcile(sessionId));

  const ended: string[] = [];
  for (const sessionId of shutdown) {
    if (markSessionEnded(sessionId, db)) {
      ended.push(sessionId);
      // ingest 的广播发生在这之前，状态变了要再播一次，页面才会换成「已结束」
      broadcast("session.updated", { session_id: sessionId, ended: true });
    }
  }

  const scheduled = [...new Set([...settled, ...shutdown])];
  for (const sessionId of scheduled) schedule(sessionId);

  return { ended, scheduled };
}
