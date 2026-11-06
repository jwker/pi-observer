/**
 * preload：渲染进程唯一能碰到主进程的入口。
 *
 * 只暴露三个方法，都是「读」，没有写、没有删除、没有任意文件路径。
 * 渲染进程拿到的就是普通数据，不知道文件在哪、也不知道 Node 存在。
 */
import { contextBridge, ipcRenderer } from "electron";

import type { EntryDetail, IpcResult, SessionListItem, SessionWindow } from "../shared/types.ts";

const api = {
  listSessions(limit?: number): Promise<IpcResult<SessionListItem[]>> {
    return ipcRenderer.invoke("sessions:list", limit);
  },

  loadSession(sessionId: string, options?: { turns?: number; before?: number }): Promise<IpcResult<SessionWindow | null>> {
    return ipcRenderer.invoke("session:window", sessionId, options);
  },

  loadEntry(sessionId: string, entryId: string): Promise<IpcResult<EntryDetail | null>> {
    return ipcRenderer.invoke("entry:detail", sessionId, entryId);
  },
};

export type PiObserverApi = typeof api;

contextBridge.exposeInMainWorld("piObserver", api);
