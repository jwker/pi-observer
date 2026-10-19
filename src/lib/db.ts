import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { checkNodeVersion, config } from "./config.ts";
import { log } from "./log.ts";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

/**
 * 本机 Node 26.5.0 的 `node:sqlite` 只导出 `DatabaseSync`；
 * 上游文档（26.12.0）已改名为 `Database`，`DatabaseSync` 变成废弃别名。
 * 改名时只改这一行（见技术选型 §4.2）。
 */
export const Db = DatabaseSync;
export type Db = DatabaseSync;

export interface DbStatus {
  path: string;
  sqliteVersion: string;
  userVersion: number;
}

/** 打开库并按 PRD §8.1 的顺序初始化 */
export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Db(path, { timeout: 5000 }); // 内置 busy_timeout
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  // 不用 auto_vacuum：M4 的清理走完整 VACUUM + wal_checkpoint(TRUNCATE)
  migrate(db);
  return db;
}

/** 新增可空列的幂等迁移：`CREATE TABLE IF NOT EXISTS` 不会给旧表补列 */
function ensureColumn(db: Db, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** 幂等迁移；只用 `PRAGMA user_version` 记版本，不做破坏性变更 */
export function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);

  if (current > SCHEMA_VERSION) {
    throw new Error(`看板库 schema 版本 ${current} 高于本程序支持的 ${SCHEMA_VERSION}，请升级 pi-observer`);
  }
  if (current === SCHEMA_VERSION) return;

  withTx(db, () => {
    db.exec(SCHEMA_SQL);
    // v3：请求记录补运行 / Turn 关联，用于 join turns 的 token 与成本。旧行保持 NULL。
    ensureColumn(db, "llm_requests", "run_seq", "INTEGER");
    ensureColumn(db, "llm_requests", "turn_index", "INTEGER");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
  log("info", "db", "schema 已就绪", { from: current, to: SCHEMA_VERSION });
}

/**
 * 手写事务包装：`node:sqlite` 没有 `db.transaction()`（技术选型 §4.2）。
 * 用 `BEGIN IMMEDIATE` 立刻拿写锁，避免批量写入时升级锁失败。
 */
export function withTx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚失败只记录，原始错误更重要
    }
    throw error;
  }
}

const GLOBAL_KEY = "__piObserverDb";

/**
 * 进程内单连接。挂在 `globalThis` 上，避免开发态热重载重复打开（PRD §8.4）。
 * 只能在服务端调用。
 */
export function getDb(): Db {
  const g = globalThis as unknown as Record<string, Db | undefined>;
  if (!g[GLOBAL_KEY]) {
    const version = checkNodeVersion();
    if (!version.ok) throw new Error(version.message);
    const cfg = config();
    g[GLOBAL_KEY] = openDb(cfg.dbPath);
    log("info", "db", "已打开看板库", { path: cfg.dbPath });
  }
  return g[GLOBAL_KEY] as Db;
}

/** 仅供测试：清掉单例，让下一个 getDb() 重新打开 */
export function resetDbSingleton(): void {
  const g = globalThis as unknown as Record<string, Db | undefined>;
  const existing = g[GLOBAL_KEY];
  if (existing) {
    try {
      existing.close();
    } catch {
      // 已关闭则忽略
    }
    delete g[GLOBAL_KEY];
  }
}

export function dbStatus(db: Db = getDb()): DbStatus {
  const sqlite = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  const version = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return {
    path: config().dbPath,
    sqliteVersion: sqlite.v,
    userVersion: Number(version?.user_version ?? 0),
  };
}
