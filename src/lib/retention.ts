/**
 * 保留期清理与空间回收（PRD §8.6）。
 *
 * **保留 7 天**：payload 与事件只留 7 天，到期自动清理，不设总量上限
 * （PRD C6）。会话文件本身不动——Pi 自己决定留多久，看板不替它删。
 *
 * **清什么**：
 *   - `messages.payload` 清空为 `{"deleted":true}`，行留着（条目 id、行号、父子关系
 *     仍有意义，而且删行会让时间线的行号对不上）；
 *   - `events` 整行删除——它只是操作痕迹，7 天后没有参考价值；
 *   - `llm_requests.payload` 与 `response_headers` 同样清空（请求体含系统提示与全部历史，
 *     是最敏感也最占空间的部分）。
 *
 * **空间回收**：`VACUUM` 之后**必须**跟一次 `PRAGMA wal_checkpoint(TRUNCATE)`。
 * 实测（WAL 模式）：只 VACUUM 不 checkpoint，主库文件不会变小，WAL 还会继续涨
 * （附录 A.6）。这两步是一个整体，不能只做一半。
 */
import { config } from "./config.ts";
import { type Db, getDb, withTx } from "./db.ts";
import { log } from "./log.ts";

export interface RetentionOutcome {
  /** 保留期截止时间（ISO） */
  cutoff: string;
  /** 清空 payload 的 messages 行数 */
  messages: number;
  /** 删除的 events 行数 */
  events: number;
  /** 清空 payload 的请求行数 */
  requests: number;
}

/**
 * 清理超过保留期的数据。
 *
 * 各表按自己的时间列判断年龄：
 *   - `messages.timestamp`：文件里的时间（回填的条目入库晚但事件发生早，
 *     按入库时间算会刚回填就被清掉）；
 *   - `events.received_at`：入库时间；
 *   - `llm_requests.created_at`：请求发出的时间。
 *
 * `jsonl_files` 不清理：它只是每个会话文件一行的读取进度（一行几十字节），
 * 而且删掉会让下次读同一个文件时从头再来一遍。
 */
export function applyRetention(db: Db, now: Date = new Date()): RetentionOutcome {
  const days = config().retentionDays;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const outcome: RetentionOutcome = {
    cutoff,
    messages: 0,
    events: 0,
    requests: 0,
  };

  withTx(db, () => {
    // 条目：清空 payload，保留行与元信息
    outcome.messages = Number(
      db
        .prepare(
          `UPDATE messages
              SET payload = '{"deleted":true}'
            WHERE payload IS NOT NULL
              AND payload <> '{"deleted":true}'
              AND COALESCE(timestamp, '') <> ''
              AND timestamp < ?`,
        )
        .run(cutoff).changes,
    );

    // 请求：清空请求体与响应头，保留序号、状态码、时间等元信息
    outcome.requests = Number(
      db
        .prepare(
          `UPDATE llm_requests
              SET payload = '{"deleted":true}', response_headers = '{"deleted":true}'
            WHERE created_at < ?
              AND (
                (payload IS NOT NULL AND payload <> '{"deleted":true}')
                OR (response_headers IS NOT NULL AND response_headers <> '{"deleted":true}')
              )`,
        )
        .run(cutoff).changes,
    );

    // 事件：整行删除
    outcome.events = Number(
      db.prepare("DELETE FROM events WHERE received_at < ?").run(cutoff).changes,
    );
  });

  log("info", "retention", "保留期清理完成", {
    cutoff,
    days,
    messages: outcome.messages,
    events: outcome.events,
    requests: outcome.requests,
  });

  return outcome;
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
        applyRetention(db);
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
  log("info", "retention", "定期清理已启动", {
    interval_ms: cfg.retentionIntervalMs,
    vacuum_interval_ms: cfg.vacuumIntervalMs,
    days: cfg.retentionDays,
  });
}

/** 停止定期清理（测试与进程收尾用） */
export function stopRetentionJobs(): void {
  const state = handle();
  if (state === undefined) return;
  clearInterval(state.timer);
  delete (globalThis as unknown as Record<string, RetentionHandle | undefined>)[GLOBAL_KEY];
}
