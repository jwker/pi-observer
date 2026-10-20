/**
 * 探针侧配置。全部可用环境变量覆盖，默认值与 PRD §7.4 / C1 一致。
 *
 * 注意令牌路径的默认值：PRD §7.6 写的是「读 `./data/token`」，但那是相对于 Pi 的 cwd，
 * 而 Pi 通常跑在用户自己的项目目录里。这里改成「相对探针文件位置」，即 pi-observer 仓库下的
 * `data/token`，这样无论 Pi 在哪个目录启动都能找到。要覆盖就设 `PI_OBSERVER_TOKEN_FILE`。
 */
import { fileURLToPath } from "node:url";

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
  /** 单条记录上限（PRD §7.4：512 KB） */
  maxRecordBytes: number;
  /** 每次模型请求往终端打一行采集摘要（长度 / 脱敏数 / 是否截断），默认关闭 */
  debugRequests: boolean;
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
  return fileURLToPath(new URL("../data/token", import.meta.url));
}

export function loadProbeConfig(env: Record<string, string | undefined> = process.env): ProbeConfig {
  const baseUrl = (env.PI_OBSERVER_URL?.trim() || "http://127.0.0.1:4173").replace(/\/+$/, "");
  return {
    baseUrl,
    ingestUrl: `${baseUrl}/api/ingest`,
    healthUrl: `${baseUrl}/api/health`,
    tokenFile: env.PI_OBSERVER_TOKEN_FILE?.trim() || defaultTokenFile(),
    batchSize: intFromEnv(env.PI_OBSERVER_BATCH_SIZE, 50),
    batchIntervalMs: intFromEnv(env.PI_OBSERVER_BATCH_INTERVAL_MS, 300),
    maxBatchRecords: intFromEnv(env.PI_OBSERVER_MAX_BATCH_RECORDS, 200),
    maxBatchBytes: intFromEnv(env.PI_OBSERVER_MAX_BATCH_BYTES, 1536 * 1024),
    maxQueueRecords: intFromEnv(env.PI_OBSERVER_MAX_QUEUE_RECORDS, 2000),
    maxQueueBytes: intFromEnv(env.PI_OBSERVER_MAX_QUEUE_BYTES, 64 * 1024 * 1024),
    maxRecordBytes: intFromEnv(env.PI_OBSERVER_MAX_RECORD_BYTES, 512 * 1024),
    debugRequests: boolFromEnv(env.PI_OBSERVER_DEBUG_REQUESTS, false),
  };
}
