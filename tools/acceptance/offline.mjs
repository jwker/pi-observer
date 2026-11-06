/**
 * 离线验收：在临时目录里跑一遍服务，检查三个接口。
 *
 * 不碰真实数据：会话目录、请求目录、端口都是临时的。
 * 用法：`npm run accept`（需要先 `npm run build`）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const standalone = join(repo, ".next", "standalone", "server.js");

if (!existsSync(standalone)) {
  console.error("没有 .next/standalone，先跑 npm run build");
  process.exit(1);
}

const line = (value) => `${JSON.stringify(value)}\n`;

function fixture(sessionsRoot, storeRoot) {
  const dir = join(sessionsRoot, "--tmp-demo--");
  mkdirSync(dir, { recursive: true });
  const body =
    line({
      type: "session",
      version: 3,
      id: "sess-accept",
      timestamp: "2026-11-02T11:40:26.856Z",
      cwd: "/tmp/demo",
    }) +
    line({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-11-02T11:40:30.000Z",
      message: { role: "user", content: [{ type: "text", text: "验收一下" }] },
    }) +
    line({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-11-02T11:40:33.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "好" }],
        model: "demo",
        usage: { input: 10, output: 5, cost: { total: 0.01 } },
      },
    });
  writeFileSync(join(dir, "2026-11-02T11-40-26-856Z_sess-accept.jsonl"), body, "utf8");

  // 请求正文目录：一个请求文件，时间在助手消息之前
  const store = join(storeRoot, "sess-accept");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "req-000001-20261102T114032000Z.json"), JSON.stringify({ model: "demo" }), "utf8");
  return store;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

const root = mkdtempSync(join(tmpdir(), "pi-observer-accept-"));
const sessionsDir = join(root, "sessions");
const storeRoot = join(root, "requests");
mkdirSync(sessionsDir, { recursive: true });
fixture(sessionsDir, storeRoot);

const port = await freePort();
const child = spawn(process.execPath, [standalone], {
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    PI_SESSIONS_DIR: sessionsDir,
    PI_REQUEST_STORE_DIR: storeRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const base = `http://127.0.0.1:${port}`;
try {
  await waitForServer(base);

  const list = await getJson(`${base}/api/sessions`);
  check("会话列表读到了文件", list.ok === true && list.total === 1, `total=${list.total}`);
  check(
    "列表里有会话名与工作目录",
    list.sessions?.[0]?.first_user_text === "验收一下" && list.sessions?.[0]?.cwd === "/tmp/demo",
  );

  const session = await getJson(`${base}/api/session?id=sess-accept`);
  check("会话数据读到了条目", session.ok === true && session.data.totals.entries === 2);
  check("Turn 按用户消息分组", session.data.turns.length === 1 && session.data.turns[0].summary === "验收一下");
  check("用量与成本来自文件", session.data.totals.tokens_in === 10 && session.data.totals.cost === 0.01);
  check(
    "助手消息对上了请求文件",
    session.data.turns[0].rows.some((row) => row.requestId === "req-000001-20261102T114032000Z"),
  );

  const detail = await getJson(`${base}/api/detail?session=sess-accept&id=a1`);
  check("行详情给出原始条目", detail.ok === true && detail.detail.raw.message.model === "demo");

  const missing = await getJson(`${base}/api/session?id=不存在`);
  check("不存在的会话返回 404 语义的错误", missing.ok === false);
} finally {
  child.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);

async function getJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function waitForServer(base) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${base}/api/sessions`);
      if (response.ok) return;
    } catch {
      // 服务还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("服务没能在 15 秒内起来");
}
