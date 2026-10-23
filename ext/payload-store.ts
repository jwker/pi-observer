/**
 * 探针侧的正文存储：把 payload 写成文件，批次里只带相对路径。
 *
 * 为什么不在批次里传正文：模型请求动辄几 MB，走 HTTP 会被批次上限挡住，
 * 也会把内存队列撑爆。写成文件之后，批次回到几十 KB。
 *
 * 同步写：文件写好之后批次才发出去，服务端入库时文件一定在。
 * 本机磁盘写 2 MB 大约几毫秒，可以接受。
 */
import { dirname } from "node:path";

import {
  type PayloadKind,
  payloadRelPath,
  writePayloadFile,
} from "../src/lib/payload-files.ts";

export interface StoredPayload {
  /** 相对 payloads 根目录的路径 */
  path: string;
  /** 原始字节数 */
  bytes: number;
}

export interface PayloadStore {
  /** 根目录（绝对路径），批次里会报给服务端做一致性检查 */
  root(): string;
  /** 写一个正文文件，返回它的引用；写不了时返回 null */
  write(kind: PayloadKind, sessionId: string, id: string, value: unknown): StoredPayload | null;
  /** 写失败时记一条日志（只提醒一次级别的问题由调用方决定） */
  onError?: (message: string) => void;
}

/** 序列化失败（循环引用等）时的占位 */
const UNSERIALIZABLE = JSON.stringify({ unserializable: true });

export interface PayloadStoreOptions {
  /**
   * 正文根目录。可以传函数：数据目录变了以后，同一个存储要跟着写到新目录去
   *（探针不用重启 Pi 就能跟上）。
   */
  root: string | (() => string);
  log?: (message: string) => void;
}

export function createPayloadStore(options: PayloadStoreOptions): PayloadStore {
  const rootOption = options.root;
  const root = (): string => (typeof rootOption === "function" ? rootOption() : rootOption);

  return {
    root,
    onError: options.log,
    write(kind, sessionId, id, value) {
      let content: string;
      try {
        content = JSON.stringify(value ?? null);
      } catch {
        content = UNSERIALIZABLE;
      }
      if (content === undefined) content = UNSERIALIZABLE;

      const relPath = payloadRelPath(kind, sessionId, id);
      try {
        const bytes = writePayloadFile(root(), relPath, content);
        return { path: relPath, bytes };
      } catch (error) {
        options.log?.(`正文写入失败（${kind}/${id}）：${(error as Error).message}`);
        return null;
      }
    },
  };
}
