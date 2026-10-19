/**
 * 档 B：模型请求采集（PRD §14 M3 的前两条 + §8.2 的 request_seq）。
 *
 * 做两件事：
 *   1. 起隔离实例 + 真实 Pi（`-p`），断言每次请求在 `llm_requests` 里有一行，
 *      payload 已脱敏、`payload_bytes` 与探针打印的原始长度一致、状态码与响应头可见；
 *   2. 用同一个会话文件再跑一次 Pi（模拟 `--resume`），断言 `request_seq` 接着上次继续，
 *      不会从 1 重新开始覆盖旧记录。
 *
 * ⚠️ 会调用真实模型（2 轮、每次 1 个请求，token 很少）。
 *
 * 用法：node tools/acceptance/real-pi/request-capture.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  REPO,
  buildIfNeeded,
  freePort,
  makeTempDir,
  openTempDb,
  sleep,
  startServer,
  waitForHealth,
} from "../lib/harness.mjs";

const dataDir = makeTempDir("pi-observer-request-");
const sessionsDir = join(dataDir, "sessions");
mkdirSync(sessionsDir, { recursive: true });
const tokenPath = join(dataDir, "token");
const port = await freePort();

console.log(`隔离实例：端口 ${port}｜数据 ${dataDir}`);
await buildIfNeeded();

const server = await startServer({ dataDir, port });
const base = server.base;
const cleanup = async () => {
  await server.stop().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
};

/** 跑一次真实 Pi，返回退出码、stdout、stderr 与探针打印的请求摘要 */
async function runPi(args, label) {
  console.log(`\n=== ${label} ===`);
  const child = spawn("pi", args, {
    cwd: REPO,
    env: {
      ...process.env,
      PI_OBSERVER_URL: base,
      PI_OBSERVER_TOKEN_FILE: tokenPath,
      PI_OBSERVER_DEBUG_REQUESTS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", (value) => resolve(value ?? -1)));
  console.log(`pi 退出码：${code}｜stdout：${stdout.trim().slice(0, 120).replace(/\n/g, " ")}`);

  const logged = [...stderr.matchAll(/请求 #(\d+)：原始 (\d+) 字节，脱敏 (\d+) 处，存 (\d+) 字节/g)].map((match) => ({
    seq: Number(match[1]),
    originalBytes: Number(match[2]),
    redacted: Number(match[3]),
    storedBytes: Number(match[4]),
  }));
  if (logged.length === 0) {
    console.error(`探针没有打印请求摘要。stderr 前 500 字：\n${stderr.slice(0, 500)}`);
  }
  return { code, stdout, stderr, logged };
}

function findSessionFile(root, sessionId) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) return full;
    }
  }
  return null;
}

try {
  await waitForHealth(base);

  // 令牌在第一次写入尝试时才生成
  await fetch(`${base}/api/ingest`, { method: "POST" }).catch(() => {});
  for (let i = 0; i < 50 && !existsSync(tokenPath); i += 1) await sleep(100);
  if (!existsSync(tokenPath)) throw new Error("隔离实例没有生成令牌");

  const first = await runPi(
    ["-p", "只回复两个字母：ok", "-nt", "-ne", "-e", join(REPO, "ext"), "--session-dir", sessionsDir],
    "1. 第一次运行（新会话）",
  );
  if (first.code !== 0) throw new Error(`第一次 pi 退出码 ${first.code}`);

  // 探针在 session_shutdown 里最多花 3 秒把积压发完
  await sleep(1500);

  let db = await openTempDb(dataDir);
  const firstRows = db.prepare("SELECT * FROM llm_requests ORDER BY request_seq").all();
  const sessionId = db.prepare("SELECT session_id FROM sessions ORDER BY last_activity_at DESC LIMIT 1").get()?.session_id;
  db.close();
  if (!sessionId) throw new Error("库里没有会话");
  if (firstRows.length === 0) throw new Error("第一次运行后 llm_requests 里没有记录");

  const sessionFile = findSessionFile(sessionsDir, sessionId);
  if (sessionFile === null) throw new Error("找不到第一次运行的会话文件");

  const second = await runPi(
    ["-p", "再回复两个字母：ok", "-nt", "-ne", "-e", join(REPO, "ext"), "--session", sessionFile, "--session-dir", sessionsDir],
    "2. 第二次运行（--resume 同一个会话文件）",
  );
  if (second.code !== 0) throw new Error(`第二次 pi 退出码 ${second.code}`);
  await sleep(1500);

  db = await openTempDb(dataDir);
  let rows;
  let joined;
  try {
    rows = db.prepare("SELECT * FROM llm_requests ORDER BY request_seq").all();
    joined = db
      .prepare(
        `SELECT r.request_seq, r.run_seq, r.turn_index, t.message_entry_id, t.tokens_in, t.tokens_out
           FROM llm_requests r
           LEFT JOIN turns t
             ON t.session_id = r.session_id AND t.run_seq = r.run_seq AND t.turn_index = r.turn_index
          ORDER BY r.request_seq`,
      )
      .all();
  } finally {
    db.close();
  }

  const seqs = rows.map((row) => Number(row.request_seq));
  const distinctSeqs = new Set(seqs);
  const maxFirstRun = Math.max(...first.logged.map((item) => item.seq), 0);
  const secondSeqs = second.logged.map((item) => item.seq);
  const secondContinued = secondSeqs.length > 0 && secondSeqs.every((seq) => seq > maxFirstRun);

  const result = {
    "第一次运行请求数": firstRows.length,
    "第一次序号": firstRows.map((row) => row.request_seq).join(", "),
    "第二次运行请求数": second.logged.length,
    "第二次序号": secondSeqs.join(", "),
    总行数: rows.length,
    序号唯一: distinctSeqs.size === rows.length,
    序号跨进程继续: secondContinued,
    有状态码: rows.every((row) => typeof row.status === "number"),
    有响应头: rows.every((row) => row.response_headers !== null),
    "payload_bytes > 0": rows.every((row) => Number(row.payload_bytes) > 0),
    截断行数: rows.filter((row) => Number(row.payload_truncated) === 1).length,
    有运行与Turn: rows.every((row) => row.run_seq !== null && row.turn_index !== null),
    关联到Turn: joined.filter((row) => row.message_entry_id !== null).length,
    有token: joined.filter((row) => row.tokens_in !== null).length,
  };
  console.log("\n=== 3. 结果 ===");
  console.table([result]);

  const problems = [];
  if (!result.序号唯一) problems.push("request_seq 有重复（新进程覆盖了旧记录）");
  if (!secondContinued) {
    problems.push(`第二次运行的序号没有接着第一次（第一次 ${maxFirstRun}，第二次 ${secondSeqs.join(",") || "无"}）`);
  }
  if (!result.有状态码) problems.push("有记录没拿到响应状态码");
  if (!result.有响应头) problems.push("有记录没拿到响应头");
  if (!result["payload_bytes > 0"]) problems.push("有记录的 payload_bytes 是 0");
  if (!result.有运行与Turn) problems.push("有请求记录没带 run_seq / turn_index");
  if (result.关联到Turn === 0) problems.push("请求没有关联到任何 Turn（token 与成本会显示为空）");
  if (result.有token === 0) problems.push("关联到的 Turn 没有 token");
  if (first.logged.length !== firstRows.length) {
    problems.push(`第一次运行打印了 ${first.logged.length} 条请求摘要、库里 ${firstRows.length} 行`);
  }

  for (const printed of first.logged) {
    const row = firstRows.find((item) => Number(item.request_seq) === printed.seq);
    if (!row) {
      problems.push(`打印的请求 #${printed.seq} 在库里找不到`);
      continue;
    }
    if (Number(row.payload_bytes) !== printed.originalBytes) {
      problems.push(`请求 #${printed.seq} 的 payload_bytes ${row.payload_bytes} 与打印的原始长度 ${printed.originalBytes} 不一致`);
    }
  }

  // 脱敏：这次提示词与响应头里没有真实凭据，检查结构里没有出现常见的敏感键
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    const text = JSON.stringify(payload);
    if (text.includes("Bearer sk-")) problems.push(`请求 #${row.request_seq} 的 payload 里出现未脱敏的 Bearer 值`);
  }

  if (problems.length > 0) {
    console.error(`\n✘ 未通过：\n  · ${problems.join("\n  · ")}`);
    console.error(`\n服务端日志尾部：\n${server.tailLog(20)}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\n✔ 请求记录：第一次 #${firstRows.map((row) => row.request_seq).join(",")}，` +
        `--resume 后 #${secondSeqs.join(",")}（未覆盖）；状态码与响应头齐全，payload_bytes 与打印一致；` +
        `${result.关联到Turn}/${rows.length} 条请求关联到 Turn，token 可读`,
    );
  }
} catch (error) {
  console.error(`\n验收中断：${error.message}`);
  console.error(`服务端日志尾部：\n${server.tailLog(30)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
