import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "./config.ts";
import { log } from "./log.ts";

/**
 * 会话令牌（PRD §12）：首次启动生成，权限 0600，只用于 `/api/ingest`。
 * 读取接口是只读的，不要求令牌；写入必须带 `x-observer-token`。
 */
export function ensureToken(path: string = config().tokenPath): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // 权限修正失败不影响可用性
      }
      return existing;
    }
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // 同上
  }
  log("info", "auth", "已生成新的会话令牌", { path });
  return token;
}

/**
 * 定时安全比较。长度不同直接返回 false（`timingSafeEqual` 要求等长输入）。
 * 长度信息本身不是秘密：令牌长度固定。
 */
export function tokensMatch(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
