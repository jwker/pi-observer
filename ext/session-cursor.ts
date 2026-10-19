/**
 * 会话级持久游标（PRD §8.2：`request_seq` 与 `run_seq` 都是会话内自增）。
 *
 * 为什么需要落盘：Pi 进程退出后再用 `--resume` 打开同一个会话时，探针是全新的实例。
 * 如果两个序号都从 1 重新开始：
 *   - `UNIQUE(session_id, request_seq)` 会让新请求覆盖旧请求；
 *   - `runs` 的 `(session_id, run_seq)` 会覆盖上一轮运行，turns / 时间线分组也会撞车。
 *
 * 位置与令牌文件同目录：`<data>/session-cursor/<会话哈希>.json`，不写 Pi 的会话文件。
 * 兼容旧的 `request-seq/<哈希>.seq`（只存过 request_seq 的纯数字文件）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SessionCursor {
  requestSeq: number;
  runSeq: number;
}

export interface SessionCursorStore {
  readonly file: string;
  load(): SessionCursor;
  save(cursor: SessionCursor): void;
}

function valid(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

export function sessionCursorStore(tokenFile: string, sessionId: string): SessionCursorStore {
  const root = dirname(tokenFile);
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  const file = join(root, "session-cursor", `${key}.json`);
  const legacyFile = join(root, "request-seq", `${key}.seq`);
  let ensured = false;

  return {
    file,
    load() {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionCursor>;
        return {
          requestSeq: valid(parsed.requestSeq) ? parsed.requestSeq : 0,
          runSeq: valid(parsed.runSeq) ? parsed.runSeq : 0,
        };
      } catch {
        // 没有新游标：尝试旧的纯数字 request_seq 文件
        try {
          const legacy = Number(readFileSync(legacyFile, "utf8").trim());
          return { requestSeq: valid(legacy) ? legacy : 0, runSeq: 0 };
        } catch {
          return { requestSeq: 0, runSeq: 0 };
        }
      }
    },
    save(cursor) {
      if (!ensured) {
        mkdirSync(join(root, "session-cursor"), { recursive: true });
        ensured = true;
      }
      writeFileSync(file, `${JSON.stringify(cursor)}\n`, { encoding: "utf8", mode: 0o600 });
    },
  };
}
