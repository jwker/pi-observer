/**
 * 单行 JSON 日志（技术选型 T9）。
 * 写 stderr，同时在内存里保留最近 200 条，供探针状态页展示。不引日志库。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  extra?: Record<string, unknown>;
}

const RING_SIZE = 200;
const ring: LogEntry[] = [];

export function log(level: LogLevel, scope: string, msg: string, extra?: Record<string, unknown>): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, scope, msg };
  if (extra) entry.extra = extra;
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // 日志失败不影响业务
  }
}

/** 返回副本，避免调用方改动内存中的日志 */
export function recentLogs(limit = 50): LogEntry[] {
  return ring.slice(-limit).map((e) => ({ ...e }));
}
