/**
 * 把 `desktop/build/icon.svg` 渲染成 macOS 的 `.icns`。
 *
 * 为什么需要这个脚本：macOS 自带的 `sips` 不读 SVG，`iconutil` 只吃 PNG。
 * 中间这一步用无头 Chrome 渲染（仓库里 `tools/shot.mjs` 也是这个路子）。
 *
 * 依赖：Google Chrome（/Applications/Google Chrome.app）、sips、iconutil。
 *
 * 用法：node tools/desktop/render-icon.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9344;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SVG = join(REPO, "desktop", "build", "icon.svg");
const OUT = join(REPO, "desktop", "build", "icon.icns");
const ICONSET = "/tmp/pi-observer.iconset";
const PNG = join(ICONSET, "icon_1024x1024.png");

if (!existsSync(SVG)) throw new Error(`找不到 ${SVG}`);
if (!existsSync(CHROME)) throw new Error("没找到 Chrome，渲染不了 SVG");

// 1) 渲染成 1024×1024 的 PNG
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/pi-render-icon/profile",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* 等 Chrome 起来 */
    }
    await delay(250);
  }
  throw new Error("Chrome 没起来");
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1024,
  height: 1024,
  deviceScaleFactor: 1,
  mobile: false,
});
const svg = readFileSync(SVG, "utf8");
await send("Page.navigate", {
  url: `data:text/html,<html><body style="margin:0">${svg.replace(/#/g, "%23")}</body></html>`,
});
await delay(1200);
const shot = await send("Page.captureScreenshot", { format: "png", omitBackground: true });

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });
writeFileSync(PNG, Buffer.from(shot.data, "base64"));
ws.close();
chrome.kill();

// 2) 各尺寸 + @2x
const sizes = [
  [16, "icon_16x16.png"],
  [32, "icon_32x32.png"],
  [64, "icon_64x64.png"],
  [128, "icon_128x128.png"],
  [256, "icon_256x256.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_1024x1024.png"],
  [32, "icon_16x16@2x.png"],
  [64, "icon_32x32@2x.png"],
  [256, "icon_128x128@2x.png"],
  [512, "icon_256x256@2x.png"],
  [1024, "icon_512x512@2x.png"],
];
for (const [size, name] of sizes) {
  const result = spawnSync("sips", ["-z", String(size), String(size), PNG, "--out", join(ICONSET, name)], {
    stdio: "ignore",
  });
  if (result.status !== 0) throw new Error(`sips 生成 ${name} 失败`);
}

// 3) 拼成 icns
const result = spawnSync("iconutil", ["-c", "icns", ICONSET, "-o", OUT], { stdio: "ignore" });
if (result.status !== 0) throw new Error("iconutil 失败");

console.log(`图标已生成：${OUT}`);
process.exit(0);
