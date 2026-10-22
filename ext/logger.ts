/**
 * 探针日志的落点。
 *
 * 为什么不写 stderr：探针跑在用户的 Pi 进程里，而同一个 Pi 会同时打开很多项目。
 * 探针往 stderr 打一行报错，用户在自己项目的终端里就会突然看到一条与自己无关的消息
 * （真实经历：「批次被拒绝，已丢弃 7 条」出现在某个项目里）。
 *
 * 所以默认只写文件：`<data>/probe.log`（与令牌同目录）。要看到它：
 *   - `tail -f data/probe.log`；
 *   - 或设 `PI_OBSERVER_DEBUG=1` 让它同时打到 stderr（自己排查时才用）。
 *
 * 文件会轮转：超过上限就改名成 `.1`，只保留最近两代，避免长期占磁盘。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** 单个日志文件的上限；超过就轮转 */
const MAX_BYTES = 1024 * 1024;

export interface ProbeLogger {
  /** 写一条日志（不带换行） */
  log(message: string): void;
  /** 日志文件路径；写不了时为 null */
  file(): string | null;
}

export interface LoggerOptions {
  /** 日志目录；通常与令牌文件同目录 */
  dir: string;
  /** 是否同时打到 stderr（PI_OBSERVER_DEBUG=1） */
  toStderr: boolean;
  /** 文件名，默认 probe.log */
  name?: string;
}

export function createProbeLogger(options: LoggerOptions): ProbeLogger {
  const name = options.name ?? "probe.log";
  const file = join(options.dir, name);
  let ensured = false;
  let writable = true;

  const ensureDir = (): boolean => {
    if (ensured) return true;
    try {
      mkdirSync(options.dir, { recursive: true });
      ensured = true;
      return true;
    } catch {
      writable = false;
      return false;
    }
  };

  return {
    file: () => file,
    log(message: string): void {
      const line = `[pi-observer] ${message}`;

      if (options.toStderr) {
        try {
          console.error(line);
        } catch {
          // stderr 写不了就算了
        }
      }

      if (!writable || !ensureDir()) {
        // 写不了文件时，至少别让消息彻底消失（但也不刷屏：只提醒一次）
        if (!options.toStderr) {
          try {
            console.error(line);
          } catch {
            // 忽略
          }
        }
        return;
      }

      try {
        const stats = statSync(file);
        if (stats.size > MAX_BYTES) {
          try {
            renameSync(file, `${file}.1`);
          } catch {
            // 轮转失败就继续写同一个文件
          }
        }
      } catch {
        // 文件还不存在
      }

      try {
        appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8");
      } catch {
        writable = false;
      }
    },
  };
}

/** 日志目录：与令牌文件同目录（即 `data/`） */
export function probeLogDir(tokenFile: string): string {
  return dirname(tokenFile);
}
