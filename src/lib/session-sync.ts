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
import {
  backfillFile,
  createBackfillContext,
  ensureSessionBackfilled,
  listSessionFiles,
  type BackfillContext,
} from "./backfill.ts";
import type { Db } from "./db.ts";
import { log } from "./log.ts";
import { broadcast } from "./sse.ts";

export const SYNC_INTERVAL_MS = 1_000;

/**
 * 发现新会话文件的间隔。
 *
 * 比每秒的同步慢：那个循环只跟进**已经知道**的活跃会话，而新会话文件得先被发现
 * 才能被跟进。探针没装或推不到服务上时，全靠这一条。
 */
export const DISCOVER_INTERVAL_MS = 10_000;

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

export interface DiscoverySummary {
  /** 会话目录里有多少个会话文件 */
  files: number;
  /** 本轮新发现的会话数 */
  discovered: number;
  /** 新入库的条目数 */
  entries: number;
  /** 新发现的会话 id */
  sessionIds: string[];
  took_ms: number;
}

/**
 * 发现运行期间新建的会话文件。
 *
 * 为什么要有：每秒的同步只跟进「库里已经知道、且状态是 active」的会话，
 * 而新会话文件（比如用户刚在一个新目录里开的对话）没人告诉服务。
 * 以前只有两条路能让它上板：探针推来 session_start，或者服务重启时全量扫描。
 * 探针没装、没跑、或者推不到服务上时，新对话就一直不显示，刷新也没用。
 *
 * 代价：每轮要列一次会话目录，并对每个文件查一次 `jsonl_files`。
 * 目录里文件多时按 10 秒一轮的间隔走，够用也不贵。
 */
export function discoverNewSessions(ctx: BackfillContext = createBackfillContext()): DiscoverySummary {
  const started = Date.now();
  const summary: DiscoverySummary = { files: 0, discovered: 0, entries: 0, sessionIds: [], took_ms: 0 };

  let paths: string[];
  try {
    paths = listSessionFiles(ctx.sessionsDir);
  } catch (error) {
    log("warn", "sync", "读不到会话目录", { error: (error as Error).message });
    summary.took_ms = Date.now() - started;
    return summary;
  }
  summary.files = paths.length;

  for (const path of paths) {
    // 已经在库里的：活跃会话由每秒同步跟进，不在这里重复处理
    const known = ctx.db.prepare("SELECT 1 FROM jsonl_files WHERE path = ?").get(path);
    if (known !== undefined) continue;

    const result = backfillFile(path, ctx);
    if (result.sessionId === null || result.skipped) continue;
    summary.discovered += 1;
    summary.entries += result.entries;
    summary.sessionIds.push(result.sessionId);
    // 广播出去：页面据此增量拉取，不用等用户手动刷新
    broadcast("session.updated", { session_id: result.sessionId, discovered: true });
    log("info", "sync", "发现新会话", { session_id: result.sessionId, entries: result.entries });
  }

  summary.took_ms = Date.now() - started;
  return summary;
}

const GLOBAL_KEY = "__piObserverSessionSync";

interface SyncHandle {
  timer: ReturnType<typeof setInterval>;
  /** 发现新会话文件的定时器：比同步慢，单独一拍 */
  discoverTimer: ReturnType<typeof setInterval>;
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
    discoverTimer: setInterval(() => {
      if (state.running) return;
      state.running = true;
      try {
        discoverNewSessions();
      } catch (error) {
        log("warn", "sync", "发现新会话失败", { error: (error as Error).message });
      } finally {
        state.running = false;
      }
    }, Math.max(intervalMs, DISCOVER_INTERVAL_MS)),
  };
  state.timer.unref?.();
  state.discoverTimer.unref?.();
  (globalThis as unknown as Record<string, SyncHandle | undefined>)[GLOBAL_KEY] = state;
  log("info", "sync", "活跃会话同步已启动", {
    interval_ms: intervalMs,
    discover_interval_ms: Math.max(intervalMs, DISCOVER_INTERVAL_MS),
  });
}

/** 停止同步（测试与进程收尾用） */
export function stopSessionSync(): void {
  const state = handle();
  if (state === undefined) return;
  clearInterval(state.timer);
  clearInterval(state.discoverTimer);
  delete (globalThis as unknown as Record<string, SyncHandle | undefined>)[GLOBAL_KEY];
}
