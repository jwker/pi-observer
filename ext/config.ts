/**
 * 探针侧配置。全部可用环境变量覆盖，默认值与 PRD §7.4 / C1 一致。
 *
 * 令牌路径的默认值是 `~/.pi-observer/token`：
 *   - 不能相对 Pi 的 cwd（Pi 通常跑在用户自己的项目目录里）；
 *   - 也不放在 pi-observer 仓库里：看板服务在 dev 下会往数据目录持续写文件，
 *     放在仓库里会被 Turbopack 当成源码变化 → 页面不停整页重载。
 * 要覆盖就设 `PI_OBSERVER_TOKEN_FILE`（正文目录默认跟着它走）。
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ProbeConfig {
  /** 看板服务基地址 */
  baseUrl: string;
  ingestUrl: string;
  healthUrl: string;
  tokenFile: string;
  /** 队列达到多少条就立刻发一批 */
  batchSize: number;
  /** 定时发送间隔 */
  batchIntervalMs: number;
  /** 单批最多带多少条 / 多少字节（服务端上限 2 MB，这里留出余量） */
  maxBatchRecords: number;
  maxBatchBytes: number;
  /** 队列上限（PRD §7.4：2,000 条 / 64 MB） */
  maxQueueRecords: number;
  maxQueueBytes: number;
  /** 正文文件根目录；正文不再随批次传输，改为写文件 */
  payloadDir: string;
  /** 每次模型请求往日志写一行采集摘要（长度 / 脱敏数 / 是否截断），默认关闭 */
  debugRequests: boolean;
  /** 同时把探针日志打到 stderr（默认只写 data/probe.log，不打扰用户的终端） */
  debug: boolean;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return fallback;
}

/** 默认令牌路径：本文件位于 `<repo>/ext/`，令牌在 `<repo>/data/token` */
export function defaultTokenFile(): string {
  return join(homedir(), ".pi-observer", "token");
}

export function loadProbeConfig(env: Record<string, string | undefined> = process.env): ProbeConfig {
  const baseUrl = (env.PI_OBSERVER_URL?.trim() || "http://127.0.0.1:4173").replace(/\/+$/, "");
  const tokenFile = env.PI_OBSERVER_TOKEN_FILE?.trim() || defaultTokenFile();
  return {
    baseUrl,
    ingestUrl: `${baseUrl}/api/ingest`,
    healthUrl: `${baseUrl}/api/health`,
    tokenFile,
    batchSize: intFromEnv(env.PI_OBSERVER_BATCH_SIZE, 50),
    batchIntervalMs: intFromEnv(env.PI_OBSERVER_BATCH_INTERVAL_MS, 300),
    maxBatchRecords: intFromEnv(env.PI_OBSERVER_MAX_BATCH_RECORDS, 200),
    maxBatchBytes: intFromEnv(env.PI_OBSERVER_MAX_BATCH_BYTES, 1536 * 1024),
    maxQueueRecords: intFromEnv(env.PI_OBSERVER_MAX_QUEUE_RECORDS, 2000),
    maxQueueBytes: intFromEnv(env.PI_OBSERVER_MAX_QUEUE_BYTES, 64 * 1024 * 1024),
    // 正文目录跟着**实际用的**令牌文件走（不是默认路径）：
    // 令牌指到别处时，正文也必须写到同一个数据目录，否则服务端按相对路径找不到正文。
    payloadDir: env.PI_OBSERVER_PAYLOAD_DIR?.trim() || join(dirname(tokenFile), "payloads"),
    debugRequests: boolFromEnv(env.PI_OBSERVER_DEBUG_REQUESTS, false),
    debug: boolFromEnv(env.PI_OBSERVER_DEBUG, false),
  };
}
