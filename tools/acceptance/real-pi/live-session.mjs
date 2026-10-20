/**
 * 档 B：Pi 正在写会话文件时读取不失败（PRD §14 M2 第 2 条），
 * 顺带量两件与状态有关的事：
 *
 *   - M2-5：`agent_settled` 之后多久从 active 变 idle（判据：60 秒内）；
 *   - M1-1 回归：事件「发生 → 入库」的延迟（`received_at - occurred_at`，判据：2 秒内）。
 *
 * 做法：
 *   1. 起一个**隔离实例**（临时库 + 临时会话目录 + 空闲端口），不碰真实的 data/ 与 4173；
 *   2. 让真实 Pi 跑一条会用到 bash 的小任务（`pi -p`，`--extension ./ext`，
 *      `--session-dir` 指向临时目录），探针通过环境变量指到这个隔离实例；
 *   3. Pi 跑的同时，每 250 ms 触发一次回填并读一次列表：记录回填警告数、读取失败数、
 *      状态变化时间线；
 *   4. Pi 退出后等探针收尾与对账落地，把库里的条目与文件逐条对照。
 *
 * ⚠️ 会调用真实模型（1 轮、2~3 个请求，token 很少）。
 *
 * 用法：node tools/acceptance/real-pi/live-session.mjs ["给 Pi 的提示词"]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  REPO,
  buildIfNeeded,
  freePort,
  getJson,
  makeTempDir,
  sleep,
  startServer,
  waitForHealth,
} from "../lib/harness.mjs";

const prompt =
  process.argv[2] ??
  "依次执行三个命令：pwd、ls src/lib、wc -l src/lib/backfill.ts。每条都要真正执行，最后用一句话总结。";
const POLL_MS = 250;

const dataDir = makeTempDir("pi-observer-live-");
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

try {
  await waitForHealth(base);

  // 令牌在第一次写入尝试时才生成：先打一次不带令牌的请求把它逼出来
  await fetch(`${base}/api/ingest`, { method: "POST" }).catch(() => {});
  for (let i = 0; i < 50 && !existsSync(tokenPath); i += 1) await sleep(100);
  if (!existsSync(tokenPath)) throw new Error("隔离实例没有生成令牌");
  const token = readFileSync(tokenPath, "utf8").trim();

  console.log(`\n=== 1. 起真实 Pi（探针指向隔离实例）===`);
  console.log(`提示词：${prompt}`);
  const child = spawn(
    "pi",
    // -ne：不做扩展发现（否则用户级 ~/.pi/agent/extensions 里的探针会和 -e 叠加成两份）
    ["-p", prompt, "-ne", "-e", join(REPO, "ext"), "--session-dir", sessionsDir],
    {
      cwd: REPO,
      env: {
        ...process.env,
        PI_OBSERVER_URL: base,
        PI_OBSERVER_TOKEN_FILE: tokenPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  let exited = false;
  const exitCode = new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1)));

  const started = Date.now();
  const timeline = [];
  let backfills = 0;
  let warnings = 0;
  let failedReads = 0;
  let pageRead = null;
  let sessionId = null;

  while (!exited) {
    // 回填（带令牌）：Pi 正在写的时候读，任何解析失败都会出现在 warnings 里
    try {
      const response = await fetch(`${base}/api/backfill`, {
        method: "POST",
        headers: { "x-observer-token": token },
      });
      if (!response.ok) failedReads += 1;
      else warnings += ((await response.json()).summary?.warnings ?? []).length;
      backfills += 1;
    } catch {
      failedReads += 1;
    }

    try {
      const list = await getJson(`${base}/api/sessions`);
      const row = (list.json?.sessions ?? [])[0];
      if (row) {
        if (sessionId === null) sessionId = row.session_id;
        timeline.push({
          t: Date.now() - started,
          state: row.state,
          source: row.source,
          messages: row.message_count,
        });
        // 页面路径也要能在写入期间打开（进页面会触发补读）
        if (pageRead === null && sessionId !== null) {
          const page = await fetch(`${base}/?session=${encodeURIComponent(sessionId)}`);
          pageRead = { status: page.status, bytes: (await page.text()).length };
        }
      }
    } catch {
      failedReads += 1;
    }

    exited = child.exitCode !== null;
    if (!exited) await sleep(POLL_MS);
  }

  const code = await exitCode;
  console.log(`pi 退出码：${code}｜轮询 ${backfills} 次｜耗时 ${Date.now() - started} ms`);
  console.log(`pi stdout（前 300 字）：${stdout.trim().slice(0, 300).replace(/\n/g, " ")}`);
  if (stderr.trim() !== "") console.log(`pi stderr（前 300 字）：${stderr.trim().slice(0, 300).replace(/\n/g, " ")}`);

  // === 2. 等探针收尾 + 对账落地 ===
  // -p 模式跑完 Pi 就退出：最终状态要么是 idle（settle 与 shutdown 之间被看到）要么是 ended。
  console.log(`\n=== 2. 等收尾与对账（最多 20 秒）===`);
  let final = null;
  for (let i = 0; i < 80; i += 1) {
    const list = await getJson(`${base}/api/sessions`);
    const row = (list.json?.sessions ?? [])[0];
    if (row) {
      sessionId = row.session_id;
      timeline.push({
        t: Date.now() - started,
        state: row.state,
        source: row.source,
        messages: row.message_count,
      });
      if ((row.state === "idle" || row.state === "ended") && row.source === "merged") {
        final = row;
        break;
      }
    }
    await sleep(POLL_MS);
  }
  if (final === null) throw new Error("20 秒内没有等到 idle/ended + merged（探针收尾或对账没落地）");

  // === 3. 状态时间线与延迟 ===
  const firstActive = timeline.find((item) => item.state === "active") ?? null;
  const idleAfterActive = firstActive
    ? (timeline.find((item) => item.t >= firstActive.t && item.state === "idle") ?? null)
    : null;

  const stream = await getJson(`${base}/api/session?id=${encodeURIComponent(sessionId)}`);
  const rows = stream.json?.data?.events ?? [];
  // 只统计点事件：进度快照的 occurred_at 是「这一轮开始的时间」，不是快照产生的时间，
  // 拿它算投递延迟会把整轮时长算进去。
  const pointEvents = rows.filter((event) => event.event_type !== "message_progress");
  const latencies = pointEvents
    .map((event) => Date.parse(event.received_at) - Date.parse(event.occurred_at))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const median = latencies.length === 0 ? null : latencies[Math.floor(latencies.length / 2)];
  const max = latencies.length === 0 ? null : latencies[latencies.length - 1];

  // `agent_settled` 的投递延迟：idle 是探针在 settle 的同一批里发出来的 session 记录，
  // 所以「active → idle」的上界就是这条事件的入库延迟（-p 模式没有 idle 停留窗口可看）。
  const settledEvent = rows.find((event) => event.event_type === "agent_settled");
  const settleLatencyMs = settledEvent
    ? Date.parse(settledEvent.received_at) - Date.parse(settledEvent.occurred_at)
    : null;
  const idleObserved = idleAfterActive !== null;

  // === 4. 库里的条目与文件逐条对照 ===
  const file = findSessionFile(sessionsDir, sessionId);
  if (file === null) throw new Error("找不到这个会话的 JSONL 文件");
  const fileIds = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null && entry.type !== "session")
    .map((entry) => entry.id ?? null);

  const ours = await getJson(`${base}/api/session?id=${encodeURIComponent(sessionId)}`);
  const ourIds = (ours.json?.data?.messages ?? []).map((row) => row.entry_id);
  const sameEntries = fileIds.length === ourIds.length && fileIds.every((id, index) => id === ourIds[index]);

  const result = {
    session_id: sessionId,
    文件条目: fileIds.length,
    库里条目: ourIds.length,
    条目一致: sameEntries,
    消息数: final.message_count,
    回填警告: warnings,
    读取失败: failedReads,
    页面: pageRead,
    状态: `${firstActive?.state ?? "（没看到 active）"} → ${final.state}`,
    "idle 停留窗口": idleObserved ? `${idleAfterActive.t - firstActive.t} ms` : "无（-p 跑完即退出）",
    "settle 入库延迟 (ms)": settleLatencyMs,
    "事件延迟中位 (ms)": median,
    "事件延迟最大 (ms)": max,
    事件样本: latencies.length,
    进度快照: rows.length - pointEvents.length,
  };
  console.log("\n=== 3. 结果 ===");
  console.table([result]);

  const problems = [];
  if (code !== 0) problems.push(`pi 退出码 ${code}`);
  if (warnings > 0) problems.push(`回填警告 ${warnings} 条（整文件解析失败会出现在这里）`);
  if (failedReads > 0) problems.push(`读取失败 ${failedReads} 次`);
  if (!sameEntries) problems.push("库里的条目与文件不一致");
  if (pageRead?.status !== 200) problems.push(`写入期间页面打不开（${pageRead?.status ?? "没有打开"}）`);
  if (firstActive === null) problems.push("没有观察到 active");
  if (final.state !== "idle" && final.state !== "ended") problems.push(`最终状态是 ${final.state}`);
  if (settleLatencyMs === null) problems.push("没有 agent_settled 事件");
  else if (settleLatencyMs > 60_000) problems.push(`settle 入库用了 ${settleLatencyMs} ms（判据 60 秒内变 idle）`);
  if (max !== null && max > 2_000) problems.push(`事件入库延迟最大 ${max} ms（判据 2 秒）`);

  if (problems.length > 0) {
    console.error(`\n✘ 未通过：\n  · ${problems.join("\n  · ")}`);
    console.error(`\n服务端日志尾部：\n${server.tailLog(20)}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\n✔ 写入期间读取 ${backfills} 次、0 警告、0 读取失败；状态 ${firstActive.state} → ${final.state}` +
        (idleObserved ? `（idle 停留 ${idleAfterActive.t - firstActive.t} ms）` : "") +
        `；settle 入库 ${settleLatencyMs} ms；事件延迟中位 ${median} ms / 最大 ${max} ms；` +
        `条目 ${fileIds.length} 条与文件一致`,
    );
  }
} catch (error) {
  console.error(`\n验收中断：${error.message}`);
  console.error(`服务端日志尾部：\n${server.tailLog(30)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

/** 在临时会话目录里按会话 id 找 JSONL（`--session-dir` 时文件可能直接在根下，也可能在 `--cwd--` 子目录里） */
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
