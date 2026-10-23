/**
 * 存储用量统计：数据库多大、正文文件多大、各有多少条。
 *
 * 正文改成存文件之后，数据库只剩索引，占用可以忽略；真正占地方的是
 * `data/payloads/`。这个模块把两边分别算清楚，给设置页用。
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.ts";
import { type Db, getDb } from "./db.ts";
import { dirUsage, type PayloadKind, payloadsRoot } from "./payload-files.ts";

export interface StorageUsage {
  /** 数据库：主库 + WAL + 共享内存，分别列出 */
  database: {
    /** 主库文件 */
    mainBytes: number;
    /** WAL 文件 */
    walBytes: number;
    /** 共享内存文件 */
    shmBytes: number;
    /** 合计 */
    totalBytes: number;
    path: string;
  };
  /** 正文文件：按类型分 */
  files: {
    /** 合计 */
    totalBytes: number;
    /** 文件数 */
    fileCount: number;
    path: string;
    byKind: Array<{ kind: PayloadKind; bytes: number; files: number }>;
  };
  /** 合计 */
  totalBytes: number;
  /** 库里各类记录有多少条 */
  counts: {
    sessions: number;
    requests: number;
    events: number;
    messages: number;
    toolCalls: number;
  };
  /** 占空间最多的会话（按正文文件大小） */
  topSessions: Array<{ session_id: string; cwd: string; bytes: number }>;
}

const KINDS: PayloadKind[] = ["request", "event", "message"];

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 统计一个会话的正文文件占了多少字节。 */
function sessionUsage(db: Db): Array<{ session_id: string; cwd: string; bytes: number }> {
  const rows = db
    .prepare(
      `SELECT session_id, cwd FROM sessions ORDER BY last_activity_at DESC LIMIT 200`,
    )
    .all() as Array<{ session_id: string; cwd: string }>;

  const root = payloadsRoot(config().dataDir);
  const usage = rows.map((row) => {
    let bytes = 0;
    for (const kind of KINDS) {
      bytes += dirUsage(join(root, kind, row.session_id)).bytes;
    }
    return { session_id: row.session_id, cwd: row.cwd, bytes };
  });
  return usage.sort((a, b) => b.bytes - a.bytes).slice(0, 10);
}

/** 统计存储用量。 */
export function storageUsage(db: Db = getDb()): StorageUsage {
  const cfg = config();
  const root = payloadsRoot(cfg.dataDir);

  const mainBytes = fileSize(cfg.dbPath);
  const walBytes = fileSize(`${cfg.dbPath}-wal`);
  const shmBytes = fileSize(`${cfg.dbPath}-shm`);

  const byKind = KINDS.map((kind) => {
    const usage = dirUsage(join(root, kind));
    return { kind, bytes: usage.bytes, files: usage.files };
  });

  const filesTotal = byKind.reduce((sum, item) => sum + item.bytes, 0);
  const filesCount = byKind.reduce((sum, item) => sum + item.files, 0);

  const count = (sql: string): number =>
    (db.prepare(sql).get() as { n: number }).n;

  return {
    database: {
      mainBytes,
      walBytes,
      shmBytes,
      totalBytes: mainBytes + walBytes + shmBytes,
      path: cfg.dbPath,
    },
    files: {
      totalBytes: filesTotal,
      fileCount: filesCount,
      path: root,
      byKind,
    },
    totalBytes: mainBytes + walBytes + shmBytes + filesTotal,
    counts: {
      sessions: count("SELECT COUNT(*) AS n FROM sessions"),
      requests: count("SELECT COUNT(*) AS n FROM llm_requests"),
      events: count("SELECT COUNT(*) AS n FROM events"),
      messages: count("SELECT COUNT(*) AS n FROM messages"),
      toolCalls: count("SELECT COUNT(*) AS n FROM tool_calls"),
    },
    topSessions: sessionUsage(db),
  };
}
