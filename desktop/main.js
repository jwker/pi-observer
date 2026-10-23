/**
 * pi-observer 桌面外壳的主进程。
 *
 * 它做三件事：
 *   1. 挑一个空闲端口，在后台拉起看板服务（standalone 产物）；
 *   2. 等服务就绪后开一个窗口，加载它的页面；
 *   3. 退出时把服务进程一起收掉。
 *
 * 为什么用 Electron 自带的 Node 跑服务：Electron 的二进制设了
 * `ELECTRON_RUN_AS_NODE=1` 就是一个纯 Node 运行时（实测 Node 24.22，`node:sqlite` 可用），
 * 这样应用包里不用再塞一份 Node。
 *
 * 为什么端口要随机挑：`next start` 的 `-p` 会覆盖 `PORT` 环境变量，
 * 而 standalone 产物是直接跑 `server.js`，`PORT` 生效。随机端口还能避免
 * 和用户自己开着的开发服务撞车；探针靠 `probe.json` 找到服务，不受影响。
 */
const { app, BrowserWindow, shell } = require("electron");
const { existsSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

/**
 * 资源目录：打包后在 .app 的 Contents/Resources/pi-observer 下，
 * 开发时是 desktop/resources。两边的结构必须一样（server/ 与 probe/）。
 */
const resourcesDir = app.isPackaged
  ? path.join(process.resourcesPath, "pi-observer")
  : path.join(__dirname, "resources");

/** 运行数据目录：默认在工程外（家目录），和现在跑服务时一样 */
const dataDir = process.env.PI_OBSERVER_DATA_DIR || path.join(os.homedir(), ".pi-observer");

let mainWindow = null;

/** 找一个空闲端口：本机回环上随机端口，绑定后立刻放开 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** 等服务就绪：轮询 /api/health，超时就不开窗口 */
async function waitForHealth(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "未知错误";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`看板服务没起来（${lastError}）`);
}

function startServer(port) {
  const entry = path.join(resourcesDir, "server", "server.js");
  if (!existsSync(entry)) {
    throw new Error(
      `找不到服务产物：${entry}\n先跑 node tools/desktop/prepare.mjs 生成资源目录。`,
    );
  }

  // 服务直接跑在主进程里，不再另起进程。
  //
  // 为什么：另起的进程（不管是用 Electron 的二进制当 Node，还是用工具进程）
  // 都会被 macOS 当成另一个应用注册，Dock 里会多出一个没有名字的图标
  // （Next 会把进程名改成 "next-server (v16.4.2)"）。
  // 只有一个进程就没有这个问题。
  //
  // 代价：服务崩了应用也跟着崩（错误会弹窗提示），退出时要等它自己收尾。
  process.env.PORT = String(port);
  process.env.HOSTNAME = "127.0.0.1";
  process.env.PI_OBSERVER_DATA_DIR = dataDir;
  // 探针源码在应用包里：设置页的「安装探针」要从这里复制到 ~/.pi-observer/probe
  process.env.PI_OBSERVER_PROBE_DIR = path.join(resourcesDir, "probe");

  const { pathToFileURL } = require("node:url");
  void import(pathToFileURL(entry).href).catch((error) => {
    process.stderr.write(`[看板服务] 起不来：${error.message}\n`);
  });

  // Next 会把进程名改成 "next-server (v16.4.2)"，桌面上会显示成那个名字。
  // 改回来：应用在 Dock 里应该叫 pi-observer。
  const restoreTitle = () => {
    if (process.title !== "pi-observer") process.title = "pi-observer";
  };
  restoreTitle();
  const timer = setInterval(restoreTitle, 1000);
  timer.unref?.();

  return null;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "pi-observer",
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: {
      // 看板是本机只读页面，不需要任何 Node 能力
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  // 外部链接交给系统浏览器，别在应用窗口里打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(async () => {
  try {
    const port = await findFreePort();
    startServer(port);
    await waitForHealth(port);
    createWindow(port);
  } catch (error) {
    dialogError(error.message);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // macOS 上点 Dock 图标：重新拉一次服务再开窗口
      void app.whenReady().then(async () => {
        const port = await findFreePort();
        startServer(port);
        await waitForHealth(port);
        createWindow(port);
      });
    }
  });
});

function dialogError(message) {
  // 先写 stderr：弹窗之前如果就被关掉，日志还在
  process.stderr.write(`[pi-observer] 启动失败：${message}\n`);
  const { dialog } = require("electron");
  dialog.showErrorBox("pi-observer 启动失败", message);
}

app.on("window-all-closed", () => {
  // macOS 的惯例是关窗口不退出；这里退出，好让服务进程跟着收掉
  app.quit();
});

app.on("before-quit", () => {
  // 服务在主进程里，退出时不用另外收：进程一起没了。
});
