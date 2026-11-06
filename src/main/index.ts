/**
 * 主进程：开窗口，并把「读文件」这件事以 IPC 的形式提供给渲染进程。
 *
 * 分成三份的原因：渲染进程只负责显示，不碰文件系统；所有读文件的操作
 * 都在主进程，通过 preload 暴露的白名单方法调用。这样渲染进程可以
 * 保持沙箱（contextIsolation + 无 nodeIntegration）。
 */
import { BrowserWindow, app, ipcMain, shell } from "electron";
import { join } from "node:path";

import { listSessionItems, loadEntryDetail, loadSessionWindow } from "./lib/session-view.ts";
import type { EntryDetail, IpcResult, SessionListItem, SessionWindow } from "../shared/types.ts";

const isDev = !app.isPackaged;

// 排查用：设了 PI_OBSERVER_DEBUG_PORT 就开远程调试端口，可以用 CDP 查页面
const debugPort = process.env["PI_OBSERVER_DEBUG_PORT"];
if (debugPort !== undefined) app.commandLine.appendSwitch("remote-debugging-port", debugPort);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "pi-observer",
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      // 渲染进程不需要任何 Node 能力：所有文件访问都走 IPC
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  // 外部链接交给系统浏览器，别在应用窗口里打开
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 开发时连 electron-vite 起的 HMR 服务，打包后加载构建好的 html
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (isDev && devUrl !== undefined) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));

  return window;
}

/** 把可能抛异常的操作包成统一的返回形状：渲染进程只看 ok/error，不用 try/catch */
async function wrap<T>(run: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function registerIpc(): void {
  ipcMain.handle("sessions:list", (_event, limit?: number) =>
    wrap<SessionListItem[]>(() => listSessionItems(typeof limit === "number" ? limit : 500)),
  );

  ipcMain.handle("session:window", (_event, sessionId: string, options?: { turns?: number; before?: number }) =>
    wrap<SessionWindow | null>(() => loadSessionWindow(sessionId, options ?? {})),
  );

  ipcMain.handle("entry:detail", (_event, sessionId: string, entryId: string) =>
    wrap<EntryDetail | null>(() => loadEntryDetail(sessionId, entryId)),
  );
}

// 只允许开一个实例：第二次点图标就把已有窗口提到前面
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing !== undefined) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  void app.whenReady().then(() => {
    registerIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
