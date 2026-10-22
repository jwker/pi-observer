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

/**
 * 最近的 warn / error 条目（环形缓冲里筛一遍）。
 *
 * 存在的理由：服务端拒批原因（协议不匹配、批次校验失败、令牌不对、批次过大）只写 stderr，
 * 而 stderr 连的是启动它的终端，浏览器里看不到——于是探针那边只显示「批次被拒绝，已丢弃 N 条」，
 * 看板的 `dropped_count` 又因为探针从未成功上报而一直是 0，两个出口都看不出原因。
 * `/api/health` 把这里的结果带出去，下一次再发生就能直接在页面上看到。
 */
export function recentProblems(limit = 10): LogEntry[] {
  return ring
    .filter((entry) => entry.level === "warn" || entry.level === "error")
    .slice(-limit)
    .map((entry) => ({ ...entry }));
}
