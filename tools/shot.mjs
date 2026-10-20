/**
 * 用 CDP 给看板拍桌面宽度截图。
 *
 * 浏览器工具的视口只有约 716 CSS px（会走移动端断点），看桌面布局不准确；
 * 这里用 Node 内置 WebSocket 直接说 CDP，把视口设成 1440x900 再截图。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const OUT = process.argv[2] ?? "/tmp/pi-shot";
const URL_ = process.argv[3] ?? "http://127.0.0.1:4174/";
const WIDTH = Number(process.argv[4] ?? 1440);
const HEIGHT = Number(process.argv[5] ?? 900);
const THEME = process.argv[6] ?? "dark";
const ACTIONS = process.argv[7] ?? "";

mkdirSync(OUT, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${OUT}/profile-${THEME}-${WIDTH}`,
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
      // 还没起来
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
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: URL_ });
await delay(1500);

// 主题写进 localStorage 并重载，保证首屏就是目标主题
await send("Runtime.evaluate", {
  expression: `localStorage.setItem("pi-observer-theme", ${JSON.stringify(THEME)}); location.reload();`,
});
await delay(2500);

// 可选动作：点击选择器（用逗号分隔），每个之间等 400ms
for (const action of ACTIONS.split(",").filter((a) => a !== "")) {
  await send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(action)}); if (el) el.click(); return !!el; })()`,
  });
  await delay(700);
}
await delay(600);

const shot = await send("Page.captureScreenshot", { format: "png" });
const file = `${OUT}/shot-${THEME}-${WIDTH}x${HEIGHT}.png`;
writeFileSync(file, Buffer.from(shot.data, "base64"));
console.log(file);

ws.close();
chrome.kill();
process.exit(0);
