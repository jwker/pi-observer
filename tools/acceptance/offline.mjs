/**
 * 档 A：不依赖真实 Pi 的离线验收（`npm run accept`）。
 *
 * 用途：起一个隔离的服务端实例，把「建库 → 探针写入 → 文件回填 → 时间线 → 行详情」
 * 整条链路用可断言的方式跑一遍。失败会以非零退出码结束，所以能直接进 `npm run verify`。
 *
 * 与真实 Pi 有关的三条判据（探针卡顿、强杀恢复、读写并发）不在这里，
 * 见 tools/acceptance/real-pi/ 与 docs/prd-v0.2.md §14。
 *
 * **记录形状与 `ext/index.ts` 发出的完全一致**——它就是「探针 ↔ 服务端」的唯一线上契约，
 * 见 src/lib/protocol.ts（协议 v3）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  Checks,
  REPO,
  assert,
  assertEqual,
  assertIncludes,
  buildIfNeeded,
  freePort,
  getJson,
  makeTempDir,
  nowIso,
  openSse,
  openTempDb,
  postBatch,
  postRaw,
  readToken,
  sleep,
  startServer,
  waitForHealth,
} from "./lib/harness.mjs";

const PROTOCOL = 3;
const SID = "accept-offline";
const CWD = "/tmp/accept-offline";
/** 放进正文里，用于确认「内容确实从会话文件到了页面」 */
const MARKER = "验收正文标记-ACCEPT-OFFLINE-TEXT";

// ── 协议 v3 的记录形状（对应 src/lib/protocol.ts）────────────────────────

const sessionRecord = (overrides = {}) => ({
  kind: "session",
  session_id: SID,
  cwd: CWD,
  file_path: `${CWD}/session.jsonl`,
  parent_session: null,
  version: 3,
  name: null,
  started_at: "2026-10-19T08:00:00.000Z",
  last_activity_at: nowIso(),
  state: "active",
  source: "live",
  ...overrides,
});

const runRecord = (overrides = {}) => ({
  kind: "run",
  session_id: SID,
  run_seq: 1,
  started_at: "2026-10-19T08:00:00.000Z",
  ended_at: null,
  outcome: null,
  ...overrides,
});

/** 事件：v3 只推文件里没有的信息（运行状态、工具起止、请求与响应） */
const eventRecord = (eventId, { layer = "agent", type = "agent_settled", payload = {}, group = {} } = {}) => ({
  kind: "event",
  event_id: eventId,
  session_id: SID,
  layer,
  event_type: type,
  payload,
  occurred_at: nowIso(),
  run_seq: group.run_seq ?? 1,
  turn_index: group.turn_index ?? 0,
});

/** Turn：只带元信息与标量，正文由 `message_entry_id` 指向 `messages` */
const turnRecord = (overrides = {}) => ({
  kind: "turn",
  session_id: SID,
  run_seq: 1,
  turn_index: 0,
  message_entry_id: `${SID}-entry-1`,
  started_at: "2026-10-19T08:00:00.500Z",
  ended_at: "2026-10-19T08:00:02.000Z",
  stop_reason: "stop",
  thinking_level: "high",
  tokens_in: 100,
  tokens_out: 200,
  cache_read: 10,
  cache_write: 5,
  cost: 0.0123,
  ...overrides,
});

/** 工具调用：v3 不带参数与结果，只带条目引用（由文件同步器补写） */
const toolCallRecord = (overrides = {}) => ({
  kind: "tool_call",
  tool_call_id: `${SID}-tool-1`,
  session_id: SID,
  parent_tool_call_id: null,
  tool_name: "bash",
  is_error: false,
  duration_ms: 12,
  started_at: "2026-10-19T08:00:01.000Z",
  ended_at: "2026-10-19T08:00:01.012Z",
  run_seq: 1,
  turn_index: 0,
  entry_id: null,
  result_entry_id: null,
  ...overrides,
});

/** 模型请求：请求与响应按同一 `request_seq` 配对 */
const requestRecord = (overrides = {}) => ({
  kind: "request",
  session_id: SID,
  request_seq: 1,
  provider: "accept-provider",
  api: "accept-api",
  model: "accept-model",
  payload: { messages: [{ role: "user", content: MARKER }] },
  payload_bytes: 512,
  payload_truncated: false,
  status: null,
  response_headers: null,
  correlation: "serial_assumed",
  created_at: "2026-10-19T08:00:00.800Z",
  run_seq: 1,
  turn_index: 0,
  ...overrides,
});

const envelope = (records) => ({
  protocol: PROTOCOL,
  probe_version: "accept-offline",
  dropped_count: 0,
  queue_depth: 0,
  records,
});

// ── 回填用的合成会话文件（形状取自真实的 v3 会话文件）────────────────────
const BF_SID = "accept-backfill-01";
const BF_CWD = "/tmp/accept-backfill";
/** 放进用户消息正文里，用来确认入库的是文件里的内容 */
const BF_MARKER = "回填正文标记-ACCEPT-BACKFILL-TEXT";

const bfLine = (value) => `${JSON.stringify(value)}\n`;

/** 头部 + 改模型 + 用户提问 + 助手调工具 + 工具结果 */
function bfInitialFile() {
  return [
    bfLine({ type: "session", version: 3, id: BF_SID, timestamp: "2026-10-19T08:00:00.000Z", cwd: BF_CWD }),
    bfLine({ type: "model_change", id: "bf-m1", timestamp: "2026-10-19T08:00:01.000Z", modelId: "accept-model" }),
    bfLine({
      type: "message",
      id: "bf-u1",
      parentId: null,
      timestamp: "2026-10-19T08:00:02.000Z",
      message: { role: "user", content: [{ type: "text", text: BF_MARKER }] },
    }),
    bfLine({
      type: "message",
      id: "bf-a1",
      parentId: "bf-u1",
      timestamp: "2026-10-19T08:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先跑一条命令" },
          { type: "toolCall", id: "bf-call-1", name: "bash", arguments: { command: "echo hi" } },
        ],
        usage: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: { total: 0.05 } },
        stopReason: "toolUse",
        thinkingLevel: "high",
      },
    }),
    bfLine({
      type: "message",
      id: "bf-t1",
      parentId: "bf-a1",
      timestamp: "2026-10-19T08:00:04.000Z",
      message: {
        role: "toolResult",
        toolCallId: "bf-call-1",
        toolName: "bash",
        content: [{ type: "text", text: "hi" }],
        isError: false,
        durationMs: 9,
      },
    }),
  ].join("");
}

const dataDir = makeTempDir();
const port = await freePort();
const checks = new Checks("离线验收（档 A）");
/** 我主动投递过的 event_id，最后用来核对库里没有多也没有少 */
const postedEventIds = new Set();
const track = (id) => {
  postedEventIds.add(id);
  return id;
};

/** 除主实例外，回填那一段还会起第二个隔离实例；两个临时目录都要清掉 */
const tempDirs = [dataDir];

let server = null;
let sse = null;
let token = null;

try {
  await buildIfNeeded();
  server = await startServer({ dataDir, port });
  const base = server.base;

  let health;
  try {
    health = await waitForHealth(base);
  } catch (error) {
    console.error(`✘ 服务端没起来：${error.message}`);
    console.error("服务端日志尾部：");
    console.error(server.tailLog(20));
    process.exitCode = 1;
    throw error;
  }
  console.log(`· 隔离实例：${base}；数据目录 ${dataDir}\n`);

  await checks.check("A1", "健康检查：协议 v3、schema 版本、探针状态如实为空", async () => {
    assertEqual(health.ok, true, "ok");
    assertEqual(health.service, "pi-observer", "service");
    assertEqual(health.protocol, PROTOCOL, "protocol");
    assert(health.schema_user_version >= 5, `schema_user_version 应为 ≥5，实际 ${health.schema_user_version}`);
    assert("probe" in health, "健康检查应有 probe 字段");
    assertEqual(health.probe, null, "还没收到任何批次时 probe 应为 null（如实标注，不编造）");
    return `sqlite ${health.sqlite}，schema ${health.schema_user_version}，protocol ${health.protocol}，subscribers ${health.subscribers}，probe null`;
  });

  await checks.check("A2", "空库：单页与接口可用", async () => {
    const home = await getJson(`${base}/`);
    assertEqual(home.status, 200, "GET / 状态码");
    const list = await getJson(`${base}/api/sessions`);
    assertEqual(list.status, 200, "GET /api/sessions 状态码");
    assertEqual(list.json.count, 0, "新库的会话数");
    return "GET / 与 /api/sessions 都是 200，会话 0 条";
  });

  await checks.check("A3", "不带令牌写入被拒，并生成临时令牌", async () => {
    const response = await postBatch(base, null, envelope([sessionRecord()]));
    assertEqual(response.status, 401, "不带令牌写入的状态码");
    token = await readToken(dataDir);
    return `401，令牌已生成在临时目录（${token.length} 位十六进制）`;
  });

  await checks.check("A4", "错误令牌写入被拒", async () => {
    const response = await postBatch(base, "0".repeat(64), envelope([sessionRecord()]));
    assertEqual(response.status, 401, "错误令牌写入的状态码");
    return "401（长度与真令牌一致，走的是定长比较而不是长度短路）";
  });

  await checks.check("A5", "超大请求体被拒", async () => {
    // 故意不 track：这一批整体被拒，不该有任何行落库
    const body = JSON.stringify(
      envelope([
        sessionRecord(),
        eventRecord(`${SID}-oversize`, { payload: { note: "y".repeat(2_600_000) } }),
      ]),
    );
    const mb = (Buffer.byteLength(body, "utf8") / 1024 / 1024).toFixed(1);
    const response = await postRaw(base, token, body);
    assertEqual(response.status, 413, `${mb} MB 请求体的状态码`);

    // 被拒的批次不能留下任何痕迹（这条同时也证明「拒绝发生在写入之前」）
    const list = await getJson(`${base}/api/sessions`);
    assertEqual(list.json.count, 0, "被拒批次之后的会话数");
    return `${mb} MB → 413（上限 2 MB），且库里仍然 0 条会话`;
  });

  await checks.check("A6", "协议版本不对的整批被拒（v2 探针不能混进来）", async () => {
    const response = await postBatch(base, token, {
      protocol: 2,
      probe_version: "old-probe",
      dropped_count: 0,
      queue_depth: 0,
      records: [sessionRecord()],
    });
    assertEqual(response.status, 400, "v2 批次的状态码");
    assertIncludes(response.json?.error ?? response.text, "协议版本不匹配", "错误信息要说明是协议问题");

    const list = await getJson(`${base}/api/sessions`);
    assertEqual(list.json.count, 0, "被拒批次之后库里仍是 0 条会话");
    return "protocol 2 → 400（整批拒绝，提示升级探针），库里没有留下半条";
  });

  await checks.check("A6b", "拒批原因从 /api/health 读得到（页面能解释「已丢弃 N 条」）", async () => {
    // 上面 A3/A5/A6 已经产生过 warn；这里确认它们不是只写 stderr
    const health = await getJson(`${base}/api/health`);
    assertEqual(health.status, 200, "health 状态码");
    const problems = health.json.recent_problems;
    assert(Array.isArray(problems), "health 应带 recent_problems 数组");
    assert(problems.length >= 2, `至少应有 2 条 warn（令牌 / 超大批次 / 协议），实际 ${problems.length}`);

    const messages = problems.map((entry) => `${entry.scope}:${entry.msg}`);
    assert(
      messages.some((m) => m.includes("令牌")),
      `应有令牌相关 warn，实际：${messages.join(" | ")}`,
    );
    assert(
      messages.some((m) => m.includes("过大") || m.includes("批次校验失败")),
      `应有批次被拒相关 warn，实际：${messages.join(" | ")}`,
    );
    for (const entry of problems) {
      assert(["warn", "error"].includes(entry.level), `只应包含 warn/error，实际 ${entry.level}`);
      assert(typeof entry.ts === "string" && entry.ts !== "", "每条都带时间");
    }
    // 状态栏显示的是 msg + extra 里的原因，所以 extra 也必须带上来
    const withReason = problems.filter((entry) =>
      Object.values(entry.extra ?? {}).some((value) => typeof value === "string"),
    );
    assert(withReason.length > 0, "至少一条 warn 要带得上原因（extra）");
    return `${problems.length} 条可见：${problems
      .map((e) => `${e.msg}${Object.values(e.extra ?? {}).find((v) => typeof v === "string") ? `→${Object.values(e.extra ?? {}).find((v) => typeof v === "string")}` : ""}`)
      .join(" / ")}`;
  });

  await checks.check("A7", "合法批次入库：会话 / 事件 / Turn / 工具 / 请求都落库", async () => {
    const response = await postBatch(
      base,
      token,
      envelope([
        sessionRecord(),
        runRecord(),
        eventRecord(track(`${SID}-ev-agent-start`), { type: "agent_start", payload: { runSeq: 1 } }),
        eventRecord(track(`${SID}-ev-tool-start`), {
          layer: "tool",
          type: "tool_execution_start",
          payload: { toolCallId: `${SID}-tool-1`, toolName: "bash" },
        }),
        eventRecord(track(`${SID}-ev-tool-end`), {
          layer: "tool",
          type: "tool_execution_end",
          payload: { toolCallId: `${SID}-tool-1`, toolName: "bash" },
        }),
        toolCallRecord(),
        turnRecord(),
        requestRecord(),
      ]),
    );
    assertEqual(response.status, 200, "写入状态码");
    assertEqual(response.json?.ok, true, "写入响应 ok");

    const list = await getJson(`${base}/api/sessions`);
    assertEqual(list.json.count, 1, "会话数");
    assertEqual(list.json.sessions[0].session_id, SID, "会话 id");
    assertEqual(list.json.sessions[0].cwd, CWD, "会话 cwd");

    const afterHealth = await getJson(`${base}/api/health`);
    const probe = afterHealth.json.probe;
    assert(typeof probe === "object" && probe !== null, "写入后 probe 状态应可查");
    assertEqual(probe.probe_version, "accept-offline", "probe_version");
    assertEqual(probe.dropped_count, 0, "dropped_count");
    assertEqual(probe.queue_depth, 0, "queue_depth");
    assert(typeof probe.last_seen_at === "string" && probe.last_seen_at.length > 0, "last_seen_at 应有值");

    const db = await openTempDb(dataDir);
    try {
      const counts = {
        events: db.prepare("SELECT COUNT(*) AS n FROM events").get().n,
        turns: db.prepare("SELECT COUNT(*) AS n FROM turns").get().n,
        tools: db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n,
        requests: db.prepare("SELECT COUNT(*) AS n FROM llm_requests").get().n,
        runs: db.prepare("SELECT COUNT(*) AS n FROM runs").get().n,
      };
      assertEqual(counts.events, 3, "事件数");
      assertEqual(counts.turns, 1, "Turn 数");
      assertEqual(counts.tools, 1, "工具数");
      assertEqual(counts.requests, 1, "请求数");
      assertEqual(counts.runs, 1, "运行数");

      // v3 的关键约定：工具行不复制参数与结果
      const tool = db.prepare("SELECT * FROM tool_calls WHERE tool_call_id = ?").get(`${SID}-tool-1`);
      assert(tool !== undefined && tool !== null, "库里没有工具行");
      assertEqual(tool.args, null, "v3 工具行不该有 args 副本");
      assertEqual(tool.result, null, "v3 工具行不该有 result 副本");
      assertEqual(tool.entry_id, null, "探针不知道条目 id，应为 null 等文件同步器补");

      // Turn 不带正文
      const turn = db.prepare("SELECT * FROM turns WHERE message_entry_id = ?").get(`${SID}-entry-1`);
      assert(turn !== undefined && turn !== null, "库里没有 Turn 行");
      assertEqual(turn.assistant_message, null, "v3 Turn 不该复制助手正文");
      assertEqual(turn.cache_read, 10, "Turn 的缓存读取");
      assertEqual(turn.cache_write, 5, "Turn 的缓存写入");
    } finally {
      db.close();
    }

    return `会话 1、事件 3、Turn 1、工具 1、请求 1、运行 1；工具与 Turn 行都不带正文副本`;
  });

  await checks.check("A8", "重复投递同一批不产生重复行", async () => {
    const before = await openTempDb(dataDir);
    const beforeEvents = before.prepare("SELECT COUNT(*) AS n FROM events").get().n;
    const beforeTools = before.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n;
    before.close();

    const again = await postBatch(
      base,
      token,
      envelope([
        sessionRecord(),
        runRecord(),
        eventRecord(`${SID}-ev-agent-start`, { type: "agent_start", payload: { runSeq: 1 } }),
        eventRecord(`${SID}-ev-tool-start`, {
          layer: "tool",
          type: "tool_execution_start",
          payload: { toolCallId: `${SID}-tool-1`, toolName: "bash" },
        }),
        eventRecord(`${SID}-ev-tool-end`, {
          layer: "tool",
          type: "tool_execution_end",
          payload: { toolCallId: `${SID}-tool-1`, toolName: "bash" },
        }),
        toolCallRecord(),
        turnRecord(),
        requestRecord(),
      ]),
    );
    assertEqual(again.status, 200, "重复写入的状态码");

    const after = await openTempDb(dataDir);
    try {
      assertEqual(after.prepare("SELECT COUNT(*) AS n FROM events").get().n, beforeEvents, "重复投递后的事件数");
      assertEqual(after.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n, beforeTools, "重复投递后的工具数");
    } finally {
      after.close();
    }
    return `事件数保持 ${beforeEvents} 条、工具数保持 ${beforeTools} 条`;
  });

  await checks.check("A9", "单条超大 payload 被截断并打标", async () => {
    const id = track(`${SID}-cap`);
    const note = "y".repeat(1_800_000);
    const response = await postBatch(
      base,
      token,
      envelope([sessionRecord(), eventRecord(id, { payload: { note } })]),
    );
    assertEqual(response.status, 200, "1.8 MB 单条 payload 的写入状态码");

    const db = await openTempDb(dataDir);
    try {
      const row = db.prepare("SELECT payload FROM events WHERE event_id = ?").get(id);
      assert(row !== undefined && row !== null, "库里找不到这条事件");
      const stored = JSON.parse(row.payload);
      assertEqual(stored.truncated, true, "payload.truncated");
      assert(stored.bytes > 1_000_000, `payload.bytes 应接近原始长度，实际 ${stored.bytes}`);
      return `入库为 ${row.payload}（原始 ${stored.bytes} 字节，超过 512 KB 上限）`;
    } finally {
      db.close();
    }
  });

  await checks.check("A10", "写入到可见的往返延迟", async () => {
    const id = track(`${SID}-latency`);
    const started = Date.now();
    const response = await postBatch(base, token, envelope([sessionRecord(), eventRecord(id)]));
    assertEqual(response.status, 200, "写入状态码");

    let visibleAt = null;
    while (Date.now() - started < 3000) {
      const stream = await getJson(`${base}/api/session?id=${SID}`);
      if (stream.json?.data?.events?.some((event) => event.event_id === id)) {
        visibleAt = Date.now();
        break;
      }
      await sleep(20);
    }
    assert(visibleAt !== null, "写入后 3 秒内仍不可见");
    const delay = visibleAt - started;
    assert(delay < 2000, `写入到可见 ${delay} ms，超过 2000 ms 判据`);
    return `${delay} ms（直投 HTTP，不含探针的 300 ms 批量间隔——那条在 real-pi 档）`;
  });

  await checks.check("A11", "SSE 逐帧推送（两次写入两帧，不合并）", async () => {
    sse = openSse(base);
    await sse.waitConnected(5000);

    const first = track(`${SID}-sse-1`);
    let from = sse.frames.length;
    await postBatch(base, token, envelope([sessionRecord(), eventRecord(first)]));
    const frame1 = await sse.waitFor(
      (frame) => frame.event === "session.updated" && frame.data?.session_id === SID,
      5000,
      from,
    );

    const second = track(`${SID}-sse-2`);
    from = sse.frames.length;
    await postBatch(base, token, envelope([sessionRecord(), eventRecord(second)]));
    const frame2 = await sse.waitFor(
      (frame) => frame.event === "session.updated" && frame.data?.session_id === SID,
      5000,
      from,
    );

    assert(frame2.index > frame1.index, "两次写入应产生两帧，不能合并成一批");
    return `两帧间隔 ${frame2.at - frame1.at} ms，载荷 ${JSON.stringify(frame1.data)}`;
  });

  await checks.check("A12", "轮询版本号：库里没变就回 unchanged，不重传数据", async () => {
    const first = await getJson(`${base}/api/session?id=${SID}`);
    assertEqual(first.status, 200, "第一次取数的状态码");
    assertEqual(first.json.unchanged, undefined, "第一次取数应带完整数据");
    assert(typeof first.json.version === "string" && first.json.version.length > 0, "应带版本号");
    assert(first.json.data?.events?.length > 0, "数据里应有事件");

    const second = await getJson(`${base}/api/session?id=${SID}&v=${encodeURIComponent(first.json.version)}`);
    assertEqual(second.status, 200, "带版本号取数的状态码");
    assertEqual(second.json.unchanged, true, "版本一致时应回 unchanged");
    assertEqual(second.json.data, undefined, "unchanged 时不该重传数据");

    return `版本号 ${first.json.version.length} 字符；一致时只回 { unchanged: true }`;
  });

  await checks.check("A13", "单页 HTML：左栏会话 + 右栏时间线都在", async () => {
    const response = await fetch(`${base}/?session=${SID}`);
    const html = await response.text();
    assertEqual(response.status, 200, "GET / 状态码");
    assertIncludes(html, "pi-observer", "页头品牌");
    assertIncludes(html, CWD, "会话头里的工作目录");
    assertIncludes(html, SID, "页面里的会话 id");
    assertIncludes(html, "app-body", "单页外壳");
    assertIncludes(html, "sidebar", "左栏");
    assertIncludes(html, "tl-top", "右侧时间线");
    assertIncludes(html, "已到最早", "到底了的提示（这个会话只有 1 个 Turn，没有更早的）");
    return `HTTP 200，HTML ${(Buffer.byteLength(html, "utf8") / 1024).toFixed(0)} KB，含左栏与时间线`;
  });

  await checks.check("A14", "落库真相：WAL、行数与唯一性", async () => {
    const db = await openTempDb(dataDir);
    try {
      const journal = db.prepare("PRAGMA journal_mode").get();
      const counts = {
        events: db.prepare("SELECT count(*) AS n FROM events").get().n,
        distinct: db.prepare("SELECT count(DISTINCT event_id) AS n FROM events").get().n,
        turns: db.prepare("SELECT count(*) AS n FROM turns").get().n,
        tools: db.prepare("SELECT count(*) AS n FROM tool_calls").get().n,
        runs: db.prepare("SELECT count(*) AS n FROM runs").get().n,
        sessions: db.prepare("SELECT count(*) AS n FROM sessions").get().n,
      };
      assertEqual(String(journal.journal_mode).toLowerCase(), "wal", "journal_mode");
      assertEqual(counts.events, counts.distinct, "event_id 唯一性（行数 vs 去重数）");
      assertEqual(counts.sessions, 1, "sessions 行数");
      assertEqual(counts.turns, 1, "turns 行数");
      assertEqual(counts.tools, 1, "tool_calls 行数");
      assertEqual(counts.runs, 1, "runs 行数");

      for (const id of postedEventIds) {
        const row = db.prepare("SELECT count(*) AS n FROM events WHERE event_id = ?").get(id);
        assertEqual(row.n, 1, `事件 ${id} 的行数`);
      }
      assert(
        counts.events >= postedEventIds.size,
        `事件行数 ${counts.events} 少于我投递过的 ${postedEventIds.size} 条`,
      );
      return `WAL；事件 ${counts.events}（投递 ${postedEventIds.size} 条），turns 1，tool_calls 1，runs 1`;
    } finally {
      db.close();
    }
  });

  await checks.check("A15", "数据隔离：只写临时库", async () => {
    assert(existsSync(join(dataDir, "observer.db")), "临时目录里没有 observer.db");
    assert(existsSync(join(dataDir, "token")), "临时目录里没有 token");
    const list = await getJson(`${base}/api/sessions`);
    assertEqual(list.json.count, 1, "隔离库里的会话数");
    assertEqual(list.json.sessions[0].session_id, SID, "隔离库里的会话 id");
    const realDb = join(REPO, "data", "observer.db");
    return `写入 ${join(dataDir, "observer.db")}；仓库里的 ${realDb} 是否参与：${existsSync(realDb) ? "存在但未被本次验收写入" : "不存在"}`;
  });

  // ── 档 A 续：回填与单页时间线 ──────────────────────────────────────────
  // 另起一个隔离实例，会话目录里**事先**放好一份会话文件：
  // 启动扫描要在收到任何请求之前就把它入库，然后分别验证「进页面补读」与「手动触发」。
  const bfDataDir = makeTempDir();
  tempDirs.push(bfDataDir);
  const bfSessions = join(bfDataDir, "sessions", "--tmp-accept-backfill--");
  mkdirSync(bfSessions, { recursive: true });
  const bfPath = join(bfSessions, `2026-10-19T08-00-00-000Z_${BF_SID}.jsonl`);
  writeFileSync(bfPath, bfInitialFile(), "utf8");

  const bfServer = await startServer({ dataDir: bfDataDir, port: await freePort() });
  const bfBase = bfServer.base;
  try {
    await waitForHealth(bfBase);
    // 令牌在第一次写入尝试时才生成（与 /api/ingest 一致）：先用一次不带令牌的请求把它逼出来，
    // 顺便把「不带令牌被拒」这条判据记下来，稍后在 A18 里断言。
    const denied = await fetch(`${bfBase}/api/backfill`, { method: "POST" });
    const deniedStatus = denied.status;
    const bfToken = await readToken(bfDataDir);

    await checks.check("A16", "启动扫描：会话文件已入库，字段与文件一致", async () => {
      // 服务端在第一个请求之前就该扫完；这里轮询着等一下，避免依赖 register() 的时序细节
      let count = 0;
      for (let i = 0; i < 50 && count === 0; i += 1) {
        const list = await getJson(`${bfBase}/api/sessions`);
        count = list.json?.count ?? 0;
        if (count === 0) await sleep(200);
      }
      assertEqual(count, 1, "启动扫描后的会话数（没有经过任何 HTTP 写入）");

      const db = await openTempDb(bfDataDir);
      try {
        const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(BF_SID);
        assertEqual(session.cwd, BF_CWD, "cwd（来自文件头部）");
        assertEqual(session.version, 3, "version");
        assertEqual(session.source, "backfill", "source");
        assertEqual(session.state, "idle", "state（回填不推进状态）");
        assertEqual(session.started_at, "2026-10-19T08:00:00.000Z", "started_at（文件头部时间）");
        assertEqual(session.message_count, 3, "message_count");
        assertEqual(session.turn_count, 1, "turn_count");
        assertEqual(session.tool_call_count, 1, "tool_call_count");
        assertEqual(session.tokens_in, 11, "tokens_in");
        assertEqual(session.tokens_out, 22, "tokens_out");
        assertEqual(session.cache_read, 33, "cache_read");
        assertEqual(session.cache_write, 44, "cache_write");
        assertEqual(session.cost, 0.05, "cost");

        const messages = db
          .prepare("SELECT entry_id, kind, role, entry_index, text FROM messages ORDER BY entry_index")
          .all();
        assertEqual(messages.length, 4, "messages 行数（全部条目，含 model_change）");
        assertEqual(messages[0].kind, "model_change", "第一条条目的 kind");
        assertEqual(messages[0].entry_index, 2, "第一条条目的行号");
        assertEqual(messages[2].role, "assistant", "助手条目 role");
        assertIncludes(messages[1].text ?? "", BF_MARKER, "用户条目摘要含正文");

        const turn = db.prepare("SELECT * FROM turns WHERE message_entry_id = 'bf-a1'").get();
        assert(turn !== undefined && turn !== null, "库里没有 bf-a1 的 turn");
        assertEqual(turn.run_seq, 1, "回填的 run_seq 占位值");
        assertEqual(turn.turn_index, 0, "turn_index");
        assertEqual(turn.stop_reason, "toolUse", "stop_reason");
        assertEqual(turn.thinking_level, "high", "thinking_level");
        assertEqual(turn.tokens_in, 11, "turn tokens_in");
        assertEqual(turn.cache_read, 33, "turn 缓存读取");

        const tool = db.prepare("SELECT * FROM tool_calls WHERE tool_call_id = 'bf-call-1'").get();
        assert(tool !== undefined && tool !== null, "库里没有 bf-call-1 的工具调用");
        assertEqual(tool.tool_name, "bash", "tool_name");
        assertEqual(tool.is_error, 0, "is_error");
        assertEqual(tool.duration_ms, 9, "duration_ms（来自工具结果条目）");
        assertEqual(tool.entry_id, "bf-a1", "工具行指向助手条目");
        assertEqual(tool.result_entry_id, "bf-t1", "工具行指向结果条目");

        assertEqual(db.prepare("SELECT COUNT(*) AS n FROM jsonl_files").get().n, 1, "jsonl_files 行数");

        const log = bfServer.tailLog(40);
        assertIncludes(log, "启动扫描完成", "服务端日志里的启动扫描记录");
        return `4 条条目 / 1 个 turn / 1 次工具调用入库；来源 backfill，state 保持 idle，日志含启动扫描`;
      } finally {
        db.close();
      }
    });

    await checks.check("A17", "进页面补读：取数请求会把启动之后新增的内容补上", async () => {
      const marker2 = "页面补读标记-ACCEPT-BACKFILL-PAGE";
      appendFileSync(
        bfPath,
        bfLine({
          type: "message",
          id: "bf-a2",
          parentId: "bf-t1",
          timestamp: "2026-10-19T08:00:05.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: marker2 }],
            usage: { input: 5, output: 6, cost: { total: 0.01 } },
            stopReason: "stop",
          },
        }),
        "utf8",
      );

      // 先确认这一条还没入库——否则下面的断言说明不了是请求触发的
      const before = await openTempDb(bfDataDir);
      const beforeCount = before.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
      before.close();
      assertEqual(beforeCount, 4, "补读之前 messages 行数");

      const response = await getJson(`${bfBase}/api/session?id=${BF_SID}`);
      assertEqual(response.status, 200, "GET /api/session 状态码");
      assertEqual(response.json.data.messages.length, 5, "取数返回的条目数");

      const db = await openTempDb(bfDataDir);
      try {
        assertEqual(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 5, "补读之后 messages 行数");
        assertEqual(db.prepare("SELECT COUNT(*) AS n FROM turns").get().n, 2, "补读之后 turns 行数");
        const session = db.prepare("SELECT message_count, turn_count, tokens_in FROM sessions WHERE session_id = ?").get(BF_SID);
        assertEqual(session.message_count, 4, "补读之后 message_count");
        assertEqual(session.turn_count, 2, "补读之后 turn_count");
        assertEqual(session.tokens_in, 16, "补读之后 tokens_in");
        return `请求前 4 条 → 请求后 5 条条目 / 2 个 turn`;
      } finally {
        db.close();
      }
    });

    await checks.check("A18", "手动触发回填：要令牌、幂等、没变的文件跳过", async () => {
      assertEqual(deniedStatus, 401, "不带令牌触发回填的状态码");

      const first = await fetch(`${bfBase}/api/backfill`, {
        method: "POST",
        headers: { "x-observer-token": bfToken },
      });
      const firstJson = await first.json();
      assertEqual(first.status, 200, "带令牌触发回填的状态码");
      assertEqual(firstJson.ok, true, "回填响应 ok");
      assertEqual(firstJson.summary.files, 1, "扫到的文件数");
      assertEqual(firstJson.summary.skipped, 1, "本次应跳过 1 个文件（A17 已经读过）");
      assertEqual(firstJson.summary.entries, 0, "跳过时不应产出条目");

      const second = await fetch(`${bfBase}/api/backfill`, {
        method: "POST",
        headers: { "x-observer-token": bfToken },
      });
      assertEqual(second.status, 200, "第二次触发的状态码");

      const counts = await getJson(`${bfBase}/api/backfill`);
      assertEqual(counts.json.counts.messages, 5, "幂等：messages 仍是 5 条");
      assertEqual(counts.json.counts.turns, 2, "幂等：turns 仍是 2 个");
      assertEqual(counts.json.counts.sessions, 1, "幂等：sessions 仍是 1 个");
      return `无令牌 401；带令牌扫 1 个文件全部跳过；两次触发后 messages 5 / turns 2 不变`;
    });

    // ── 档 A 续：单页时间线的行模型 ──────────────────────────────────────
    await checks.check("A19", "时间线数据：一个用户 Turn 一组，prelude 装首条用户消息之前", async () => {
      const stream = await getJson(`${bfBase}/api/session?id=${BF_SID}`);
      assertEqual(stream.status, 200, "取数状态码");
      const data = stream.json.data;
      assert(data, "应带数据");
      assertEqual(data.messages.length, 5, "条目数");
      assertEqual(data.turns.length, 2, "模型 Turn 数");
      assertEqual(data.totals.messages, 5, "totals 里的条目数");
      assertEqual(data.totals.turns, 2, "totals 里的 Turn 数");
      assertEqual(data.totals.events, 0, "回填会话没有钩子事件");

      // 首条用户消息之前有条目（model_change），它属于 prelude，不单独成 Turn
      const userMessages = data.messages.filter((m) => m.role === "user");
      assertEqual(userMessages.length, 1, "用户消息数");
      const before = data.messages.filter((m) => m.entry_index < userMessages[0].entry_index);
      assert(before.length > 0, "首条用户消息之前应该有条目");

      // 工具参数只存一份：正文在 messages.payload 里
      const tool = data.tools[0];
      assert(tool !== undefined, "应有工具行");
      assertEqual(tool.entry_id, "bf-a1", "工具行指向助手条目");
      assertEqual(tool.result_entry_id, "bf-t1", "工具行指向结果条目");
      assert(tool.args_preview !== null && tool.args_preview !== "", "工具行应带参数预览");
      assert(tool.args === undefined, "工具行不该带完整参数");
      return `5 条条目 → 1 个用户 Turn + prelude；工具行带参数预览但不带完整参数`;
    });

    await checks.check("A20", "行详情：正文、工具参数与结果按需取全", async () => {
      const stream = await getJson(`${bfBase}/api/session?id=${BF_SID}`);
      const data = stream.json.data;
      const userMessage = data.messages.find((m) => m.role === "user");

      const message = await getJson(
        `${bfBase}/api/detail?session=${BF_SID}&kind=message&id=${userMessage.entry_id}`,
      );
      assertEqual(message.status, 200, "消息详情状态码");
      assertEqual(message.json.detail.kind, "message", "kind");
      assertEqual(message.json.detail.message.entry_id, userMessage.entry_id, "条目 id");
      assertIncludes(JSON.stringify(message.json.detail.message.payload), BF_MARKER, "原始条目 JSON 里的正文");
      assert(message.json.detail.message.payload_bytes > 0, "详情该带 payload 字节数");

      const tool = await getJson(
        `${bfBase}/api/detail?session=${BF_SID}&kind=tool&id=${data.tools[0].tool_call_id}`,
      );
      assertEqual(tool.status, 200, "工具详情状态码");
      assertEqual(tool.json.detail.kind, "tool", "kind");
      assertEqual(tool.json.detail.tool.args.command, "echo hi", "完整参数");
      assertEqual(tool.json.detail.tool.result.content[0].text, "hi", "完整结果");
      assertEqual(tool.json.detail.relatedMessages.length, 2, "关联的条目数（助手条目 + 结果条目）");

      const missing = await getJson(`${bfBase}/api/detail?session=${BF_SID}&kind=message&id=nope`);
      assertEqual(missing.status, 404, "取不存在的条目应 404");
      const badKind = await getJson(`${bfBase}/api/detail?session=${BF_SID}&kind=xxx&id=1`);
      assertEqual(badKind.status, 400, "非法 kind 应 400");

      return `消息详情带原始 JSON；工具详情带完整参数与结果并关联 2 个条目；不存在的条目 404、非法 kind 400`;
    });

    // ── 档 A 续：对账与状态推进 ──────────────────────────────────────────
    await checks.check("A21", "agent_settled 之后对账：补齐文件里新增的条目，live 变 merged", async () => {
      // 模拟「这一轮结束时 Pi 才把最后一条写完」：先追加进文件，再用批量写入报 settle
      appendFileSync(
        bfPath,
        bfLine({
          type: "message",
          id: "bf-a3",
          parentId: "bf-a2",
          timestamp: "2026-10-19T08:00:09.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "对账补读标记-ACCEPT-RECONCILE" }],
            usage: { input: 7, output: 8, cost: { total: 0.003 } },
            stopReason: "stop",
          },
        }),
        "utf8",
      );

      const posted = await postBatch(bfBase, bfToken, {
        protocol: PROTOCOL,
        probe_version: "0.3.0",
        dropped_count: 0,
        queue_depth: 0,
        records: [
          {
            kind: "session",
            session_id: BF_SID,
            cwd: BF_CWD,
            file_path: bfPath,
            parent_session: null,
            version: 3,
            name: null,
            started_at: "2026-10-19T08:00:00.000Z",
            last_activity_at: nowIso(),
            state: "idle",
            source: "live",
          },
          {
            kind: "event",
            event_id: "ev-settle-1",
            session_id: BF_SID,
            layer: "agent",
            event_type: "agent_settled",
            payload: { runSeq: 1, aborted: false },
            occurred_at: nowIso(),
            run_seq: 1,
            turn_index: 0,
          },
        ],
      });
      assertEqual(posted.status, 200, "写入状态与 settle 事件的状态码");

      // 刚写完：会话状态来自探针的 session 记录；条目还没补——对账在 3 秒后
      const mid = await openTempDb(bfDataDir);
      const midState = mid.prepare("SELECT state FROM sessions WHERE session_id = ?").get(BF_SID).state;
      const midEntries = mid.prepare("SELECT COUNT(*) AS n FROM messages WHERE entry_id = 'bf-a3'").get().n;
      mid.close();
      assertEqual(midState, "idle", "agent_settled 后会话状态是 idle（探针直接给出）");
      assertEqual(midEntries, 0, "对账之前，文件里新增的条目还没入库");

      // 等对账落地（3 秒定时器 + 余量）
      let seen = null;
      for (let i = 0; i < 40; i += 1) {
        const db = await openTempDb(bfDataDir);
        const session = db.prepare("SELECT source, last_reconciled_at FROM sessions WHERE session_id = ?").get(BF_SID);
        const entries = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE entry_id = 'bf-a3'").get().n;
        db.close();
        if (session.last_reconciled_at !== null && entries === 1) {
          seen = { ...session, entries };
          break;
        }
        await sleep(200);
      }
      assert(seen !== null, "8 秒内没有完成对账");
      assertEqual(seen.source, "merged", "实时 + 回填都见过 → merged");
      assertEqual(seen.entries, 1, "对账补上了文件里新增的条目");
      return `settle 后 8 秒内对账：bf-a3 入库、source merged、last_reconciled_at ${seen.last_reconciled_at}`;
    });

    await checks.check("A22", "session_shutdown：会话推进到已结束", async () => {
      const posted = await postBatch(bfBase, bfToken, {
        protocol: PROTOCOL,
        probe_version: "0.3.0",
        dropped_count: 0,
        queue_depth: 0,
        records: [
          {
            kind: "event",
            event_id: "ev-shutdown-1",
            session_id: BF_SID,
            layer: "session",
            event_type: "session_shutdown",
            payload: { reason: "quit" },
            occurred_at: nowIso(),
            run_seq: 1,
            turn_index: 0,
          },
        ],
      });
      assertEqual(posted.status, 200, "写入 shutdown 事件的状态码");

      const db = await openTempDb(bfDataDir);
      const state = db.prepare("SELECT state FROM sessions WHERE session_id = ?").get(BF_SID).state;
      db.close();
      assertEqual(state, "ended", "关闭事件到达后状态推进到 ended");

      const list = await getJson(`${bfBase}/api/sessions`);
      assertEqual(list.json.sessions[0].state, "ended", "列表接口里的状态");
      return `关闭事件 → state ended；列表接口同步`;
    });

    // ── 档 A 续：会话文件被截短（模拟重写）────────────────────────────
    await checks.check("A23", "文件被截短：识别为重写并从头重读，不产生重复条目", async () => {
      // 截成「头部 + 前两条条目」，模拟整文件重写（版本迁移 / fork）
      const lines = readFileSync(bfPath, "utf8").split("\n").filter((line) => line !== "");
      writeFileSync(bfPath, `${lines.slice(0, 3).join("\n")}\n`, "utf8");

      const before = await openTempDb(bfDataDir);
      const beforeCount = before.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
      const beforeDistinct = before.prepare("SELECT COUNT(DISTINCT entry_id) AS n FROM messages").get().n;
      before.close();

      const response = await fetch(`${bfBase}/api/backfill`, {
        method: "POST",
        headers: { "x-observer-token": bfToken },
      });
      const body = await response.json();
      assertEqual(response.status, 200, "截短后触发回填的状态码");
      assertEqual(body.summary.files, 1, "扫到的文件数");
      assertEqual(body.summary.changed, 1, "截短应被识别为「变了」而不是跳过");
      assertEqual(body.summary.entries, 2, "重读产出的条目数（头部 + 2 条条目 → 2 条）");
      assertEqual(body.summary.warnings.length, 0, "截短后重读不该有解析警告");

      const db = await openTempDb(bfDataDir);
      try {
        const total = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
        const distinct = db.prepare("SELECT COUNT(DISTINCT entry_id) AS n FROM messages").get().n;
        assertEqual(total, distinct, "不产生重复条目（行数 = 去重后的 entry_id 数）");
        // 已知边界：已经不在文件里的条目不会从库里删除——我们分不清「文件被截短」和「读取提前结束」，
        // 宁可多留也不误删。所以这里断言的是「没有多出来」，而不是「等于文件里的条目数」。
        assertEqual(total, beforeCount, "截短后库里不会多出行（原来的条目保留）");
        assertEqual(distinct, beforeDistinct, "entry_id 数不变");

        const messageRows = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'message'").get().n;
        const session = db.prepare("SELECT message_count FROM sessions WHERE session_id = ?").get(BF_SID);
        assertEqual(session.message_count, messageRows, "message_count 只数 kind=message 的行（bf-m1 是 model_change）");
      } finally {
        db.close();
      }

      return `3 行文件 → 识别为重写、重读 2 条；${beforeCount} 条条目 / ${beforeDistinct} 个 id 不变，无重复（已不在文件里的条目保留，见 PRD §9.2）`;
    });

    // ── 档 A 续：模型请求的脱敏与落库 ───────────────────────────────────
    await checks.check("A24", "模型请求：payload 脱敏、原始字节数、响应状态与 headers 落库", async () => {
      const payload = {
        model: "accept-model",
        messages: [{ role: "user", content: "请求正文标记-ACCEPT-REQUEST" }],
        authorization: "Bearer sk-acceptacceptaccept",
        headers: { "x-api-key": "accept-key" },
      };
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      const baseRecord = {
        kind: "request",
        session_id: BF_SID,
        request_seq: 1,
        correlation: "serial_assumed",
        created_at: nowIso(),
        run_seq: 9,
        turn_index: 1,
      };

      const started = await postBatch(bfBase, bfToken, {
        protocol: PROTOCOL,
        probe_version: "0.3.0",
        dropped_count: 0,
        queue_depth: 0,
        records: [
          {
            ...baseRecord,
            provider: "accept-provider",
            api: "accept-api",
            model: "accept-model",
            payload,
            payload_bytes: payloadBytes,
            payload_truncated: false,
            status: null,
            response_headers: null,
          },
          {
            kind: "event",
            event_id: "accept-provider-request-1",
            session_id: BF_SID,
            layer: "provider",
            event_type: "provider_request",
            payload: { requestSeq: 1, payloadBytes },
            occurred_at: nowIso(),
            run_seq: 1,
            turn_index: 0,
          },
        ],
      });
      assertEqual(started.status, 200, "请求开始记录的状态码");

      const answered = await postBatch(bfBase, bfToken, {
        protocol: PROTOCOL,
        probe_version: "0.3.0",
        dropped_count: 0,
        queue_depth: 0,
        records: [
          {
            ...baseRecord,
            provider: null,
            api: null,
            model: null,
            payload: null,
            payload_bytes: null,
            payload_truncated: null,
            status: 200,
            response_headers: { authorization: "secret-value", "x-ds-trace-id": "trace-accept" },
          },
          {
            kind: "event",
            event_id: "accept-provider-response-1",
            session_id: BF_SID,
            layer: "provider",
            event_type: "provider_response",
            payload: { requestSeq: 1, status: 200 },
            occurred_at: nowIso(),
            run_seq: 1,
            turn_index: 0,
          },
        ],
      });
      assertEqual(answered.status, 200, "响应更新记录的状态码");

      const db = await openTempDb(bfDataDir);
      try {
        const rows = db
          .prepare("SELECT * FROM llm_requests WHERE session_id = ? AND request_seq = 1")
          .all(BF_SID);
        assertEqual(rows.length, 1, "同一 (session_id, request_seq) 只有一行");
        const row = rows[0];
        const stored = JSON.parse(row.payload);
        assertEqual(stored.authorization, "[redacted]", "authorization 被脱敏");
        assertEqual(stored.headers["x-api-key"], "[redacted]", "x-api-key 被脱敏");
        assertIncludes(stored.messages[0].content, "ACCEPT-REQUEST", "正文照常保留");
        assertEqual(row.payload_bytes, payloadBytes, "payload_bytes 是脱敏前的原始字节数");
        assertEqual(row.payload_truncated, 0, "未超限不打截断标");
        assertEqual(row.status, 200, "响应状态码");
        assertEqual(row.model, "accept-model", "模型来自请求记录");
        assertEqual(row.correlation, "serial_assumed", "关联方式");
        const headers = JSON.parse(row.response_headers);
        assertEqual(headers.authorization, "[redacted]", "响应头里的凭据也被脱敏");
        assertEqual(headers["x-ds-trace-id"], "trace-accept", "普通响应头保留");

        const events = db
          .prepare("SELECT event_type FROM events WHERE session_id = ? AND event_type LIKE 'provider_%' ORDER BY id")
          .all(BF_SID)
          .map((item) => item.event_type);
        assertEqual(events.join(","), "provider_request,provider_response", "时间线上有请求与响应两条事件");
      } finally {
        db.close();
      }

      return `1 条请求：payload_bytes ${payloadBytes} 与原始长度一致；authorization / x-api-key / 响应头凭据都已脱敏；status 200；时间线 2 条事件`;
    });

    // ── 档 A 续：用量汇总口径 ───────────────────────────────────────────
    await checks.check("A25", "用量汇总：会话级与 Turn 级 token / 缓存 / 成本口径一致", async () => {
      const stream = await getJson(`${bfBase}/api/session?id=${BF_SID}`);
      const data = stream.json.data;
      const turns = data.turns ?? [];

      const sum = (key) => turns.reduce((total, turn) => total + (typeof turn[key] === "number" ? turn[key] : 0), 0);
      const session = data.session;
      assertEqual(session.tokens_in, sum("tokens_in"), "会话输入 = Turn 输入之和");
      assertEqual(session.tokens_out, sum("tokens_out"), "会话输出 = Turn 输出之和");
      assertEqual(session.cache_read, sum("cache_read"), "会话缓存读取 = Turn 缓存读取之和");
      assertEqual(session.cache_write, sum("cache_write"), "会话缓存写入 = Turn 缓存写入之和");
      assert(Math.abs(session.cost - sum("cost")) < 1e-9, "会话成本 = Turn 成本之和");

      // 合成文件 bf-a1：11 / 22 / R33 / W44 / $0.05；A17 的 bf-a2：5 / 6 / 无缓存 / $0.01；
      // A21 的 bf-a3：7 / 8 / 无缓存 / $0.003
      assertEqual(session.tokens_in, 23, "输入 token 汇总");
      assertEqual(session.tokens_out, 36, "输出 token 汇总");
      assertEqual(session.cache_read, 33, "缓存读取汇总");
      assertEqual(session.cache_write, 44, "缓存写入汇总");
      assert(Math.abs(session.cost - 0.063) < 1e-9, "成本汇总");

      const backfillTurn = turns.find((turn) => turn.message_entry_id === "bf-a1");
      assert(backfillTurn, "回填 Turn 在列表里");
      assertEqual(backfillTurn.cache_read, 33, "回填 Turn 的缓存读取");
      assertEqual(backfillTurn.cache_write, 44, "回填 Turn 的缓存写入");

      return `会话 23 / 36 / R33 / W44 / $0.063；与 Turn 级之和一致`;
    });

    // ── 档 A 续：保留期清理与状态自愈 ───────────────────────────────────
    // 这两项要直接写库，必须在服务停掉之后做（服务端进程还开着同一个库，写连接会拿不到锁）。
  } finally {
    await bfServer.stop();
  }

  // 服务已停，可以直接写临时库了
  try {
    await checks.check("A26", "保留期：过期 payload 被清空、事件被删除，元信息留着", async () => {
      const { openDb } = await import("../../src/lib/db.ts");
      const { applyRetention } = await import("../../src/lib/retention.ts");
      const writable = openDb(join(bfDataDir, "observer.db"));
      try {
        // 造两条 8 天前的数据
        const old = "2026-10-01T00:00:00.000Z";
        writable
          .prepare(
            `INSERT INTO messages (session_id, entry_id, parent_id, kind, role, timestamp, entry_index, text, payload)
             VALUES (?, 'old-entry', NULL, 'message', 'user', ?, 900, '旧消息', '{"a":1}')`,
          )
          .run(BF_SID, old);
        writable
          .prepare(
            `INSERT INTO events (event_id, session_id, layer, event_type, payload, occurred_at, received_at)
             VALUES ('old-event', ?, 'agent', 'agent_settled', '{}', ?, ?)`,
          )
          .run(BF_SID, old, old);
        const beforeRows = writable.prepare("SELECT COUNT(*) AS n FROM messages").get().n;

        // 保留期是 7 天：把「现在」推到 8 天后
        const shifted = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
        const outcome = applyRetention(writable, shifted);
        assert(outcome.messages >= 1, "过期条目的 payload 应被清空");
        assert(outcome.events >= 1, "过期事件应被删除");

        const oldRow = writable
          .prepare("SELECT payload, text FROM messages WHERE entry_id = 'old-entry'")
          .get();
        assertEqual(oldRow.payload, '{"deleted":true}', "过期条目的 payload");
        assertEqual(oldRow.text, "旧消息", "摘要留着");
        assertEqual(
          writable.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
          beforeRows,
          "行不会被删（删行会让时间线的行号对不上）",
        );
        assertEqual(
          writable.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = 'old-event'").get().n,
          0,
          "过期事件整行删除",
        );
      } finally {
        writable.close();
      }
      return "过期条目的 payload 清空为 {deleted:true}、行保留；过期事件整行删除；元信息不变";
    });

    await checks.check("A27", "状态自愈：文件已不存在的会话不再停在「进行中」", async () => {
      const { openDb } = await import("../../src/lib/db.ts");
      const { endSessionsWithoutFile } = await import("../../src/lib/session-state.ts");
      const writable = openDb(join(bfDataDir, "observer.db"));
      try {
        writable
          .prepare(
            `INSERT INTO sessions (session_id, cwd, file_path, state, source, last_activity_at)
             VALUES ('orphan-active', '/tmp/p', '/tmp/definitely-not-here.jsonl', 'active', 'live', ?)`,
          )
          .run(new Date().toISOString());

        const outcome = endSessionsWithoutFile(writable, { exists: () => false });
        assert(outcome.ended.includes("orphan-active"), "文件不在的 active 会话应被改成 ended");
        const state = writable
          .prepare("SELECT state FROM sessions WHERE session_id = 'orphan-active'")
          .get();
        assertEqual(state.state, "ended", "状态推进到 ended");

        // 幂等：再跑一次不再改
        const again = endSessionsWithoutFile(writable, { exists: () => false });
        assert(!again.ended.includes("orphan-active"), "重复执行是幂等的");
      } finally {
        writable.close();
      }
      return "文件已不存在的 active 会话 → ended；重复执行幂等";
    });
  } catch (error) {
    console.error(`\n验收中断：${error.message}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\n验收中断：${error.message}`);
  process.exitCode = 1;
} finally {
  sse?.close();
  if (server) await server.stop();
  const ok = checks.summary();
  if (!ok) process.exitCode = 1;
  if (ok && process.exitCode === undefined) {
    // 通过就清掉临时目录，别在 $TMPDIR 里堆垃圾
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  } else {
    console.log(`· 临时目录保留在 ${tempDirs.join("、")}（服务端日志：${server?.logPath ?? "-"}）`);
  }
}
