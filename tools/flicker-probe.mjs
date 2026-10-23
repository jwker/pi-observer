/**
 * 诊断看板页面「一直在闪屏」：用 CDP 观察 15 秒内的
 *   - 整页导航（frameNavigated）
 *   - 客户端请求（Network.requestWillBeSent）
 *   - 时间线容器的 DOM 变化（MutationObserver 计数）
 *   - 控制台错误
 * 输出时间线，用来分辨是「整页重载」还是「局部重渲染」。
 *
 * 用法：node tools/flicker-probe.mjs [url] [seconds]
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const URL_ = process.argv[2] ?? "http://127.0.0.1:4173/";
const SECONDS = Number(process.argv[3] ?? 15);

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/pi-flicker-profile`,
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
      /* 还没起来 */
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
const events = [];
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  switch (msg.method) {
    case "Page.frameNavigated":
      events.push(`${at()} 整页导航 ${msg.params.frame.url}`);
      break;
    case "Page.frameStartedLoading":
      events.push(`${at()} 开始加载 ${msg.params.frameId}`);
      break;
    case "Network.requestWillBeSent":
      events.push(`${at()} 请求 ${msg.params.request.method} ${msg.params.request.url}`);
      break;
    case "Runtime.consoleAPICalled":
      if (msg.params.type === "error" || msg.params.type === "warning") {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        events.push(`${at()} 控制台(${msg.params.type}) ${text.slice(0, 300)}`);
      }
      break;
    case "Runtime.exceptionThrown":
      events.push(`${at()} 异常 ${msg.params.exceptionDetails.text}`);
      break;
    default:
      break;
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
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: URL_ });
await delay(3000);

// 在页面里挂观察器：DOM 变化计数 + 滚动位置 + 帧数
await send("Runtime.evaluate", {
  expression: `
    window.__probe = { domChanges: 0, firstMutation: null, lastMutation: null, samples: [] };
    const start = performance.now();
    const obs = new MutationObserver((records) => {
      window.__probe.domChanges += records.length;
      const t = ((performance.now() - start) / 1000).toFixed(2);
      if (window.__probe.firstMutation === null) window.__probe.firstMutation = t;
      window.__probe.lastMutation = t;
    });
    const root = document.querySelector(".tl") ?? document.body;
    obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    setInterval(() => {
      const scroller = document.querySelector(".tl-scroll");
      window.__probe.samples.push({
        t: ((performance.now() - start) / 1000).toFixed(2),
        scrollTop: scroller ? scroller.scrollTop : null,
        scrollHeight: scroller ? scroller.scrollHeight : null,
        rows: document.querySelectorAll("[data-row-key]").length,
        turns: document.querySelectorAll(".turn").length,
      });
    }, 250);
    true;
  `,
});

await delay(SECONDS * 1000);

const result = await send("Runtime.evaluate", {
  expression: "JSON.stringify(window.__probe)",
  returnByValue: true,
});

console.log("=== 事件 ===");
for (const line of events) console.log(line);
console.log("=== 采样（每 250ms）===");
console.log(result.result.value);

ws.close();
chrome.kill();
process.exit(0);
