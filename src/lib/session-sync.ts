/**
 * 活跃会话的文件同步（PRD §9.1）。
 *
 * 正文只有一条路径：Pi 写会话文件 → 看板把新字节读进 `messages.payload`。
 * 探针不再转发流式正文，所以这里要在会话进行中持续跟进：
 *
 *   - 每 1 秒扫一遍 `sessions.state = 'active'` 的会话；
 *   - 文件大小 + 修改时间没变时 `backfillFile` 只做两次 stat，直接跳过；
 *   - 有新条目时写库并广播 `session.updated`，页面据此增量拉取；
 *   - `agent_settled` 之后由 `reconcile.ts` 再读最后一次，兜住文件写入的延迟。
 *
 * 只处理 `active`：`idle` / `ended` 的会话不会自己再长，等下次启动扫描或进页面补读即可。
 *
 * 定时器挂在 `globalThis` 上，开发态热重载不会叠出第二个循环；`unref()` 保证它
 * 不拖住进程退出。
 */
import { createBackfillContext, ensureSessionBackfilled, type BackfillContext } from "./backfill.ts";
import type { Db } from "./db.ts";
import { log } from "./log.ts";
import { broadcast } from "./sse.ts";

export const SYNC_INTERVAL_MS = 1_000;

export interface SyncSummary {
  /** 本轮检查的活跃会话数 */
  sessions: number;
  /** 文件有变化、写入条目的会话数 */
  changed: number;
  /** 新入库的条目数 */
  entries: number;
  took_ms: number;
}

function activeSessionIds(db: Db): string[] {
  const rows = db
    .prepare("SELECT session_id FROM sessions WHERE state = 'active' ORDER BY COALESCE(last_activity_at, '') DESC")
    .all() as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

/** 同步一次；供定时器与测试直接调用 */
export function syncActiveSessions(ctx: BackfillContext = createBackfillContext()): SyncSummary {
  const started = Date.now();
  const summary: SyncSummary = { sessions: 0, changed: 0, entries: 0, took_ms: 0 };

  for (const sessionId of activeSessionIds(ctx.db)) {
    summary.sessions += 1;
    try {
      const result = ensureSessionBackfilled(sessionId, ctx);
      if (result === null) continue;
      if (result.entries > 0) {
        summary.changed += 1;
        summary.entries += result.entries;
        broadcast("session.updated", { session_id: sessionId, synced: true });
      }
    } catch (error) {
      // 单个文件读失败不能中断其他会话；下一轮会重试
      log("warn", "sync", "活跃会话同步失败", { session_id: sessionId, error: (error as Error).message });
    }
  }

  summary.took_ms = Date.now() - started;
  return summary;
}

const GLOBAL_KEY = "__piObserverSessionSync";

interface SyncHandle {
  timer: ReturnType<typeof setInterval>;
  running: boolean;
}

function handle(): SyncHandle | undefined {
  return (globalThis as unknown as Record<string, SyncHandle | undefined>)[GLOBAL_KEY];
}

/**
 * 启动每秒同步。重复调用是幂等的：已有循环就直接返回。
 * `intervalMs` 只给测试用，生产固定 1 秒。
 */
export function startSessionSync(intervalMs = SYNC_INTERVAL_MS): void {
  if (handle() !== undefined) return;

  const state: SyncHandle = {
    running: false,
    timer: setInterval(() => {
      // 上一轮还没跑完（大文件、慢磁盘）就跳过这一拍，不排队堆积
      if (state.running) return;
      state.running = true;
      try {
        syncActiveSessions();
      } finally {
        state.running = false;
      }
    }, intervalMs),
  };
  state.timer.unref?.();
  (globalThis as unknown as Record<string, SyncHandle | undefined>)[GLOBAL_KEY] = state;
  log("info", "sync", "活跃会话同步已启动", { interval_ms: intervalMs });
}

/** 停止同步（测试与进程收尾用） */
export function stopSessionSync(): void {
  const state = handle();
  if (state === undefined) return;
  clearInterval(state.timer);
  delete (globalThis as unknown as Record<string, SyncHandle | undefined>)[GLOBAL_KEY];
}
