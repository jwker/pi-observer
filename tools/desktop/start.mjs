/**
 * 桌面版的启动入口。
 *
 * 两种模式：
 *   默认      先构建（next build + 组装资源目录），再起 Electron；
 *   `--dev`   直接用 `next dev` 起服务，Electron 连上去——不用构建，改代码即时生效。
 *
 * 这两种都还不是发布物：发布物由 electron-builder 打成 .app / .dmg，
 * 入口在 desktop/package.json 的 pack 与 dmg 脚本里。
 *
 * Electron 依赖没装时自动装一次（只装一次，之后就快了）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT, HOST, findFreePort } from "../port.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const DESKTOP = join(REPO, "desktop");

const dev = process.argv.includes("--dev");

/** Electron 的可执行文件（desktop/node_modules/.bin/electron） */
const ELECTRON = join(DESKTOP, "node_modules", ".bin", "electron");

function ensureElectron() {
  if (existsSync(ELECTRON)) return;
  console.log("== 装 Electron 依赖（第一次会久一点）==");
  const result = spawnSync("npm", ["install"], {
    cwd: DESKTOP,
    stdio: "inherit",
    env: {
      ...process.env,
      // Electron 的二进制不在 npm 包里，要另外下；默认走国内镜像
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/",
    },
  });
  if (result.status !== 0) {
    console.error("装 Electron 依赖失败");
    process.exit(1);
  }
}

function build() {
  console.log("== 构建服务 ==");
  const result = spawnSync(process.execPath, [join(HERE, "prepare.mjs")], { stdio: "inherit", cwd: REPO });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** 等某个地址的看板服务回话 */
async function waitForServer(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/sessions?limit=1`);
      if (response.ok) return true;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("看板服务没能在 60 秒内起来");
}

ensureElectron();

let devServer = null;
let baseUrl = null;

if (dev) {
  // 开发模式：自己起一个 next dev，窗口连它
  const wanted = Number(process.env.PORT ?? DEFAULT_PORT);
  const { port } = await findFreePort(Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_PORT, HOST);
  baseUrl = `http://${HOST}:${port}`;
  console.log(`== 开发模式：看板地址 ${baseUrl} ==`);
  devServer = spawn(process.execPath, [join(REPO, "tools", "dev.mjs")], {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, PORT: String(port) },
  });
  await waitForServer(baseUrl);
} else {
  build();
}

const electron = spawn(ELECTRON, ["."], {
  cwd: DESKTOP,
  stdio: "inherit",
  env: { ...process.env, ...(baseUrl === null ? {} : { PI_OBSERVER_URL: baseUrl }) },
});

const stop = () => {
  devServer?.kill("SIGTERM");
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    electron.kill(signal);
  });
}
electron.on("exit", (code) => {
  stop();
  process.exit(code ?? 0);
});
