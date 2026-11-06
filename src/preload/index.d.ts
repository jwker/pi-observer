/**
 * 渲染进程看到的 window.piObserver 的类型声明。
 *
 * 与 preload 暴露的方法一一对应；类型从 shared 里取，
 * 保证两边看到的是同一份数据形状。
 */
import type { EntryDetail, IpcResult, SessionListItem, SessionWindow } from "../shared/types.ts";

declare global {
  interface Window {
    piObserver: {
      listSessions(limit?: number): Promise<IpcResult<SessionListItem[]>>;
      loadSession(
        sessionId: string,
        options?: { turns?: number; before?: number },
      ): Promise<IpcResult<SessionWindow | null>>;
      loadEntry(sessionId: string, entryId: string): Promise<IpcResult<EntryDetail | null>>;
    };
  }
}

export {};
