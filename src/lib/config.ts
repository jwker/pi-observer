import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** 只监听回环地址，不可配置为其他值 */
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly tokenPath: string;
  /** Pi 会话文件根目录（真相源） */
  readonly sessionsDir: string;
  /** 单批请求体上限（字节）。框架不兜底，必须自己限 */
  readonly ingestMaxBytes: number;
  /** 清理间隔 */
  readonly retentionIntervalMs: number;
  /** 空间回收（VACUUM + checkpoint）间隔 */
  readonly vacuumIntervalMs: number;
  /** `agent_settled` 之后多久触发对账 */
  readonly reconcileDelayMs: number;
  /** SSE 心跳间隔 */
  readonly sseHeartbeatMs: number;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 校验 Node 版本：`>=24 <27`。
 * 下限来自 `node:sqlite`，上限是保守值（大版本可能改默认行为，见技术选型 T12）。
 */
export function checkNodeVersion(version: string = process.versions.node): { ok: true } | { ok: false; message: string } {
  const [majorRaw] = version.split(".");
  const major = Number(majorRaw);
  if (!Number.isFinite(major)) {
    return { ok: false, message: `无法解析 Node 版本：${version}` };
  }
  if (major < 24 || major >= 27) {
    return {
      ok: false,
      message: `本项目要求 Node >= 24 且 < 27（当前 ${version}）。下限来自 node:sqlite。`,
    };
  }
  return { ok: true };
}

/** 只依赖「字符串环境变量表」，不绑定 NodeJS.ProcessEnv，方便测试传字面量 */
export type EnvRecord = Record<string, string | undefined>;

export function loadConfig(env: EnvRecord = process.env): Config {
  const cwd = process.cwd();
  // 数据目录默认放在**工程外**（~/.pi-observer）：
  // 放在仓库里的 data/ 会被 Turbopack 的文件监听看到——看板自己在往里写正文、日志与 WAL，
  // 每次写入都触发一次重编译，dev 下页面就会不停整页重载（实测每秒 2~6 次）。
  const dataDir = env.PI_OBSERVER_DATA_DIR?.trim() || join(homedir(), ".pi-observer");
  const sessionsDir = env.PI_OBSERVER_SESSIONS_DIR?.trim() || join(homedir(), ".pi", "agent", "sessions");

  return {
    host: "127.0.0.1",
    port: intFromEnv(env.PORT, 4173),
    dataDir,
    dbPath: join(dataDir, "observer.db"),
    tokenPath: join(dataDir, "token"),
    sessionsDir,
    ingestMaxBytes: intFromEnv(env.PI_OBSERVER_INGEST_MAX_BYTES, 2 * 1024 * 1024),
    retentionIntervalMs: intFromEnv(env.PI_OBSERVER_RETENTION_INTERVAL_MS, 60 * 60 * 1000),
    vacuumIntervalMs: intFromEnv(env.PI_OBSERVER_VACUUM_INTERVAL_MS, 24 * 60 * 60 * 1000),
    reconcileDelayMs: intFromEnv(env.PI_OBSERVER_RECONCILE_DELAY_MS, 3000),
    sseHeartbeatMs: intFromEnv(env.PI_OBSERVER_SSE_HEARTBEAT_MS, 25 * 1000),
  };
}

let cached: Config | undefined;

/** 进程内单例配置（与库连接一样，避免热重载反复计算） */
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
