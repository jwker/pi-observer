/**
 * 空间回收（PRD §8.6）。
 *
 * **不再自动删数据**：正文改成存文件之后，看板不再按天清 payload / 消息 / 事件。
 * 容量由使用者自己控制：看板上看到占用变大就手动导出或删除对应会话的正文文件。
 * 自动删除会让人以为数据还在，其实早就没了——这个坑不值得踩。
 *
 * **空间回收**：`VACUUM` 之后**必须**跟一次 `PRAGMA wal_checkpoint(TRUNCATE)`。
 * 实测（WAL 模式）：只 VACUUM 不 checkpoint，主库文件不会变小，WAL 还会继续涨
 * （附录 A.6）。这两步是一个整体，不能只做一半。
 */
import { config } from "./config.ts";
import { type Db, getDb, withTx } from "./db.ts";
import { log } from "./log.ts";

export interface RetentionOutcome {
  /** 保留期截止时间（ISO）；不再自动清理，恒为 null */
  cutoff: null;
  /** 清空 payload 的 messages 行数；不再清理，恒为 0 */
  messages: 0;
  /** 删除的 events 行数；不再清理，恒为 0 */
  events: 0;
  /** 清空 payload 的请求行数；不再清理，恒为 0 */
  requests: 0;
}

/**
 * 兼容旧调用点：现在什么都不清。
 *
 * 数据要删由人显式决定（看板上导出后手动处理），不由定时任务替人做主。
 */
export function applyRetention(_db: Db, _now: Date = new Date()): RetentionOutcome {
  return { cutoff: null, messages: 0, events: 0, requests: 0 };
}

/**
 * 回收磁盘空间。
 *
 * `VACUUM` 会重写整个库，代价与库大小成正比，所以不在每次清理后都做——
 * 按 `vacuumIntervalMs`（默认一天）单独跑一次。
 */
export function reclaimSpace(db: Db): void {
  const started = Date.now();
  try {
    db.exec("VACUUM");
    // 这一步不能省：只 VACUUM 的话 WAL 模式下的主库文件不会变小（附录 A.6）
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    log("info", "retention", "空间回收完成", { took_ms: Date.now() - started });
  } catch (error) {
    log("warn", "retention", "空间回收失败", { error: (error as Error).message });
  }
}

const GLOBAL_KEY = "__piObserverRetention";

interface RetentionHandle {
  timer: ReturnType<typeof setInterval>;
  running: boolean;
  lastVacuumAt: number;
}

function handle(): RetentionHandle | undefined {
  return (globalThis as unknown as Record<string, RetentionHandle | undefined>)[GLOBAL_KEY];
}

/**
 * 启动定期清理。
 *
 * 两个节奏：
 *   - 保留期清理：每小时一次（`retentionIntervalMs`）；
 *   - 空间回收：每 24 小时一次（`vacuumIntervalMs`），与清理分开——VACUUM 很贵。
 *
 * 定时器挂在 `globalThis` 上（开发态热重载不会叠出第二个循环），`unref()` 保证它
 * 不拖住进程退出。
 */
export function startRetentionJobs(db: Db = getDb()): void {
  if (handle() !== undefined) return;
  const cfg = config();

  const state: RetentionHandle = {
    running: false,
    lastVacuumAt: Date.now(),
    timer: setInterval(() => {
      if (state.running) return;
      state.running = true;
      try {
        if (Date.now() - state.lastVacuumAt >= cfg.vacuumIntervalMs) {
          state.lastVacuumAt = Date.now();
          reclaimSpace(db);
        }
      } catch (error) {
        log("warn", "retention", "定期清理失败", { error: (error as Error).message });
      } finally {
        state.running = false;
      }
    }, cfg.retentionIntervalMs),
  };
  state.timer.unref?.();
  (globalThis as unknown as Record<string, RetentionHandle | undefined>)[GLOBAL_KEY] = state;
  log("info", "retention", "定期空间回收已启动", {
    interval_ms: cfg.retentionIntervalMs,
    vacuum_interval_ms: cfg.vacuumIntervalMs,
  });
}

/** 停止定期清理（测试与进程收尾用） */
export function stopRetentionJobs(): void {
  const state = handle();
  if (state === undefined) return;
  clearInterval(state.timer);
  delete (globalThis as unknown as Record<string, RetentionHandle | undefined>)[GLOBAL_KEY];
}
