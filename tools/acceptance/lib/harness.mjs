/**
 * 验收脚本的公共脚手架。
 *
 * 用途：起一个**隔离的**服务端实例、等待就绪、提供断言、SSE 读取与结果汇总。
 *
 * 隔离手段（三件事，缺一不可）：
 *   1. `PI_OBSERVER_DATA_DIR` 指向临时目录 → 用到的是临时 observer.db 与临时令牌，
 *      永远不碰仓库里的 `data/`；
 *   2. `PI_OBSERVER_SESSIONS_DIR` 指向临时目录 → 回填不会去扫你真实的会话文件；
 *   3. 端口取自系统的空闲端口 → 不会撞上你正在跑的 4173 实例，也不需要杀掉它。
 *
 * 这一层只做「起服务 + 断言」，具体查什么由各验收脚本决定。
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录（本文件在 tools/acceptance/lib/ 下） */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NEXT_BIN = join(REPO, "node_modules", ".bin", "next");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const nowIso = () => new Date().toISOString();

/** 向系统要一个空闲端口（要完就还，只用来避开 4173） */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("拿不到空闲端口"))));
    });
  });
}

export function makeTempDir(prefix = "pi-observer-accept-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * `next start` 需要先有构建产物。
 * 没有产物、或**源码比产物新**（改完 src 忘了 build）都会先构建一次：
 * 否则 `npm run accept` 可能在一个过期的产物上「通过」，那是假绿。
 */
export async function buildIfNeeded() {
  const stampPath = join(REPO, ".next", "BUILD_ID");
  const reason = !existsSync(stampPath)
    ? "没有找到 .next/BUILD_ID"
    : newestSourceMtime() > statSync(stampPath).mtimeMs
      ? "源码比构建产物新（改完没重新 build）"
      : null;
  if (reason === null) return false;

  console.log(`· ${reason}，先执行一次 next build`);
  const code = await new Promise((resolve) => {
    const child = spawn(NEXT_BIN, ["build"], { cwd: REPO, stdio: "inherit" });
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`next build 失败，退出码 ${code}`);
  return true;
}

/** 参与构建的源码里最新的改动时间（只看会进产物的目录与配置文件） */
function newestSourceMtime() {
  let newest = 0;
  const visit = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        visit(full);
      } else {
        try {
          const mtime = statSync(full).mtimeMs;
          if (mtime > newest) newest = mtime;
        } catch {
          // 读不到就跳过
        }
      }
    }
  };
  for (const dir of ["src", "ext"]) visit(join(REPO, dir));
  for (const file of ["next.config.ts", "tsconfig.json", "package.json", "package-lock.json"]) {
    try {
      const mtime = statSync(join(REPO, file)).mtimeMs;
      if (mtime > newest) newest = mtime;
    } catch {
      // 文件不存在
    }
  }
  return newest;
}

function readTail(path, lines = 15) {
  try {
    const all = readFileSync(path, "utf8").trimEnd().split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "(读不到日志)";
  }
}

/**
 * 起一个隔离的服务端。返回的对象里 `stop()` 只杀自己起的这个进程组，
 * 不会误伤别的 4173 实例。
 */
export async function startServer({ dataDir, port }) {
  const logPath = join(dataDir, "server.log");
  const fd = openSync(logPath, "a");
  const child = spawn(NEXT_BIN, ["start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      PORT: String(port),
      PI_OBSERVER_DATA_DIR: dataDir,
      PI_OBSERVER_SESSIONS_DIR: join(dataDir, "sessions"),
    },
  });
  child.unref();

  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已经退出
      }
    }
    await sleep(200);
    try {
      closeSync(fd);
    } catch {
      // 已经关了
    }
  };

  return {
    pid: child.pid,
    base: `http://127.0.0.1:${port}`,
    logPath,
    stop,
    tailLog: (lines) => readTail(logPath, lines),
  };
}

export async function waitForHealth(base, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "还没有响应";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(300);
  }
  throw new Error(`等待服务就绪超时（${timeoutMs} ms）：${lastError}`);
}

/**
 * 读令牌。服务端在第 1 次写入尝试时才生成令牌（`ensureToken`），
 * 所以这里允许等一会儿——验收脚本第 3 项就是「不带令牌写入被拒」。
 */
export async function readToken(dataDir, timeoutMs = 5000) {
  const path = join(dataDir, "token");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const token = readFileSync(path, "utf8").trim();
      if (token !== "") return token;
    }
    await sleep(100);
  }
  throw new Error(`读不到令牌文件：${path}`);
}

/** 只读打开验收自己的库（临时库），用于核对「落库真相」 */
export async function openTempDb(dataDir) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(join(dataDir, "observer.db"), { readOnly: true });
}

export async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应
  }
  return { status: response.status, json, text };
}

/** `token` 传 null 表示故意不带令牌 */
export async function postBatch(base, token, batch) {
  const headers = { "content-type": "application/json" };
  if (token !== null) headers["x-observer-token"] = token;
  const response = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify(batch),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应
  }
  return { status: response.status, json, text };
}

/** 大批次：不经过 JSON.stringify 之外的加工，直接拼一个超大请求体 */
export async function postRaw(base, token, body) {
  const response = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-observer-token": token },
    body,
  });
  return { status: response.status, text: await response.text() };
}

/** 订阅 SSE；`connected()` 等到服务端确认订阅已建立，避免「先发后订阅」的竞态 */
export function openSse(base) {
  const controller = new AbortController();
  const frames = [];
  const listeners = new Set();
  let connected = false;

  (async () => {
    const response = await fetch(`${base}/api/stream`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (raw.startsWith(":")) continue; // 注释帧（心跳）
        const event = /^event: (.+)$/m.exec(raw)?.[1] ?? "(无 event)";
        const dataLine = /^data: (.+)$/m.exec(raw)?.[1];
        let data = null;
        try {
          data = dataLine ? JSON.parse(dataLine) : null;
        } catch {
          // 数据不是 JSON
        }
        if (event === "probe.status" && data?.connected === true) connected = true;
        const frame = { event, data, at: Date.now(), index: frames.length };
        frames.push(frame);
        for (const listener of listeners) listener(frame);
      }
    }
  })().catch(() => {
    // 关闭时的 abort 属正常
  });

  const waitFor = (predicate, timeoutMs, from = 0) =>
    new Promise((resolve, reject) => {
      const found = frames.slice(from).find(predicate);
      if (found) return resolve(found);
      const timer = setTimeout(() => {
        listeners.delete(onFrame);
        reject(new Error(`等 SSE 帧超时（${timeoutMs} ms）`));
      }, timeoutMs);
      const onFrame = (frame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        listeners.delete(onFrame);
        resolve(frame);
      };
      listeners.add(onFrame);
    });

  const waitConnected = async (timeoutMs = 5000) => {
    if (connected) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !connected) await sleep(50);
    if (!connected) throw new Error(`等 SSE 连接确认超时（${timeoutMs} ms）`);
  };

  return { frames, waitFor, waitConnected, close: () => controller.abort() };
}

/** 断言：失败抛错，由 Checks 记成一条失败 */
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

export function assertIncludes(haystack, needle, what) {
  if (typeof haystack !== "string" || !haystack.includes(needle)) {
    throw new Error(`${what}：未找到 ${JSON.stringify(needle)}`);
  }
}

/** 逐项执行、逐项打印，最后给汇总与退出码 */
export class Checks {
  constructor(title) {
    this.title = title;
    this.results = [];
  }

  async check(id, name, run) {
    try {
      const detail = await run();
      this.results.push({ id, name, ok: true, detail: detail ?? "" });
      console.log(`✔ ${id} ${name}${detail ? `  — ${detail}` : ""}`);
    } catch (error) {
      this.results.push({ id, name, ok: false, detail: error.message });
      console.log(`✘ ${id} ${name}\n      ${error.message}`);
    }
  }

  summary() {
    const failed = this.results.filter((item) => !item.ok);
    console.log("");
    console.log(`${this.title}：共 ${this.results.length} 项，通过 ${this.results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      console.log("失败项：");
      for (const item of failed) console.log(`  ${item.id} ${item.name} — ${item.detail}`);
    }
    return failed.length === 0;
  }
}
