/**
 * 请求序号的持久游标（PRD §8.2：`request_seq` 会话内自增）。
 *
 * 为什么需要落盘：Pi 进程退出后再用 `--resume` 打开同一个会话时，探针是全新的实例。
 * 如果序号从 1 重新开始，`UNIQUE(session_id, request_seq)` 会让新请求覆盖旧请求。
 *
 * 位置与令牌文件同目录（默认 `<repo>/data/request-seq/<会话哈希>.seq`），
 * 不写 Pi 的会话文件；文件很小，只存一个整数。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RequestSeqStore {
  readonly file: string;
  load(): number;
  save(seq: number): void;
}

export function requestSeqStore(tokenFile: string, sessionId: string): RequestSeqStore {
  const dir = join(dirname(tokenFile), "request-seq");
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  const file = join(dir, `${key}.seq`);
  let ensured = false;

  return {
    file,
    load() {
      try {
        const value = Number(readFileSync(file, "utf8").trim());
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
      } catch {
        return 0;
      }
    },
    save(seq) {
      if (!ensured) {
        mkdirSync(dir, { recursive: true });
        ensured = true;
      }
      writeFileSync(file, `${seq}\n`, { encoding: "utf8", mode: 0o600 });
    },
  };
}
