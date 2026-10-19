/**
 * 档 A：不依赖真实 Pi 的离线验收（`npm run accept`）。
 *
 * 用途：起一个隔离的服务端实例，把「建库 → 写入 → 落库 → SSE → 页面」整条链路
 * 用可断言的方式跑一遍。失败会以非零退出码结束，所以能直接进 `npm run verify`。
 *
 * 与真实 Pi 有关的三条判据（探针卡顿、强杀恢复、读写并发）不在这里，
 * 见 tools/acceptance/real-pi/ 与 docs/prd-v0.2.md §14。
 *
 * 记录形状与 `ext/index.ts` 发出的完全一致——它就是「探针 ↔ 服务端」的唯一线上契约。
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

const SID = "accept-offline";
const CWD = "/tmp/accept-offline";
/** 放进正文里，用于确认「详情页 HTML 里真的有消息内容」 */
const MARKER = "验收正文标记-ACCEPT-OFFLINE-TEXT";

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

const runRecord = () => ({
  kind: "run",
  session_id: SID,
  run_seq: 1,
  started_at: "2026-10-19T08:00:00.000Z",
  ended_at: null,
  outcome: null,
});

const eventRecord = (eventId, { layer = "turn", type = "turn_start", payload = {}, group = {} } = {}) => ({
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

const progressRecord = (text) => ({
  kind: "progress",
  session_id: SID,
  run_seq: 1,
  turn_index: 0,
  text,
  update_count: 7,
  started_at: nowIso(),
});

const toolCallRecord = () => ({
  kind: "tool_call",
  tool_call_id: `${SID}-tool-1`,
  session_id: SID,
  parent_tool_call_id: null,
  tool_name: "bash",
  args: { command: "ls ext" },
  result: { text: "client.ts config.ts flush.ts" },
  partial_result: null,
  is_error: false,
  duration_ms: 12,
  started_at: "2026-10-19T08:00:01.000Z",
  ended_at: "2026-10-19T08:00:01.012Z",
});

const turnRecord = (marker) => ({
  kind: "turn",
  session_id: SID,
  run_seq: 1,
  turn_index: 0,
  message_entry_id: `${SID}-entry-1`,
  started_at: "2026-10-19T08:00:00.500Z",
  ended_at: "2026-10-19T08:00:02.000Z",
  stop_reason: "stop",
  thinking_level: "high",
  assistant_message: { role: "assistant", content: [{ type: "text", text: marker }] },
  tool_results: [{ toolCallId: `${SID}-tool-1`, isError: false }],
  tokens_in: 100,
  tokens_out: 200,
  cost: 0.0123,
});

const envelope = (records) => ({
  protocol: 2,
  probe_version: "accept-offline",
  dropped_count: 0,
  queue_depth: 0,
  records,
});

// ── M2-2 回填用的合成会话文件（形状取自真实的 v3 会话文件）────────────────
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

  await checks.check("A1", "健康检查", async () => {
    assertEqual(health.ok, true, "ok");
    assertEqual(health.service, "pi-observer", "service");
    assertEqual(health.protocol, 2, "protocol");
    assert(health.schema_user_version >= 1, `schema_user_version 应为 ≥1，实际 ${health.schema_user_version}`);
    assert("probe" in health, "健康检查应有 probe 字段");
    assertEqual(health.probe, null, "还没收到任何批次时 probe 应为 null（如实标注，不编造）");
    return `sqlite ${health.sqlite}，schema ${health.schema_user_version}，subscribers ${health.subscribers}，probe null`;
  });

  await checks.check("A2", "空库：列表页与接口可用", async () => {
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

  await checks.check("A6", "合法批次入库，会话 / 事件 / 探针状态可查", async () => {
    const markerEvent = track(`${SID}-ev-tool-end`);
    const response = await postBatch(
      base,
      token,
      envelope([
        sessionRecord(),
        runRecord(),
        eventRecord(track(`${SID}-ev-turn-start`), { layer: "turn", type: "turn_start" }),
        eventRecord(track(`${SID}-ev-message-start`), { layer: "message", type: "message_start", payload: { role: "assistant" } }),
        eventRecord(markerEvent, { layer: "tool", type: "tool_execution_end", payload: { toolName: "bash" } }),
        progressRecord(MARKER),
        toolCallRecord(),
        turnRecord(MARKER),
      ]),
    );
    assertEqual(response.status, 200, "写入状态码");
    assertEqual(response.json?.ok, true, "写入响应 ok");

    const list = await getJson(`${base}/api/sessions`);
    assertEqual(list.json.count, 1, "会话数");
    const session = list.json.sessions[0];
    assertEqual(session.session_id, SID, "会话 id");
    assertEqual(session.cwd, CWD, "会话 cwd");

    const events = await getJson(`${base}/api/sessions/${SID}/events?limit=2000`);
    assertEqual(events.status, 200, "事件接口状态码");
    const types = events.json.events.map((event) => event.event_type);
    assert(types.includes("message_progress"), `应有 message_progress，实际 ${JSON.stringify(types)}`);

    const turns = await getJson(`${base}/api/sessions/${SID}/turns`);
    assertEqual(turns.status, 200, "Turn 接口状态码");
    assertEqual(turns.json.count, 1, "Turn 数");

    const afterHealth = await getJson(`${base}/api/health`);
    const probe = afterHealth.json.probe;
    assert(typeof probe === "object" && probe !== null, "写入后 probe 状态应可查");
    assertEqual(probe.probe_version, "accept-offline", "probe_version");
    assertEqual(probe.dropped_count, 0, "dropped_count");
    assertEqual(probe.queue_depth, 0, "queue_depth");
    assert(typeof probe.last_seen_at === "string" && probe.last_seen_at.length > 0, "last_seen_at 应有值");

    return `写入 200；会话 1，事件 ${events.json.count}（含 message_progress），Turn ${turns.json.count}，probe.last_seen_at ${probe.last_seen_at}`;
  });

  await checks.check("A7", "重复投递同一批不产生重复行", async () => {
    const before = await getJson(`${base}/api/sessions/${SID}/events?limit=2000`);
    const again = await postBatch(
      base,
      token,
      envelope([
        sessionRecord(),
        eventRecord(`${SID}-ev-turn-start`, { layer: "turn", type: "turn_start" }),
        eventRecord(`${SID}-ev-message-start`, { layer: "message", type: "message_start", payload: { role: "assistant" } }),
        eventRecord(`${SID}-ev-tool-end`, { layer: "tool", type: "tool_execution_end", payload: { toolName: "bash" } }),
        progressRecord(MARKER),
        toolCallRecord(),
        turnRecord(MARKER),
      ]),
    );
    assertEqual(again.status, 200, "重复写入的状态码");
    const after = await getJson(`${base}/api/sessions/${SID}/events?limit=2000`);
    assertEqual(after.json.count, before.json.count, "重复投递后的事件数");
    return `事件数保持 ${after.json.count} 条`;
  });

  await checks.check("A8", "单条超大 payload 被截断并打标", async () => {
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

  await checks.check("A9", "写入到可见的往返延迟", async () => {
    const id = track(`${SID}-latency`);
    const started = Date.now();
    const response = await postBatch(base, token, envelope([sessionRecord(), eventRecord(id)]));
    assertEqual(response.status, 200, "写入状态码");

    let visibleAt = null;
    while (Date.now() - started < 3000) {
      const events = await getJson(`${base}/api/sessions/${SID}/events?limit=2000`);
      if (events.json.events.some((event) => event.event_id === id)) {
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

  await checks.check("A10", "SSE 逐帧推送（两次写入两帧，不合并）", async () => {
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

  await checks.check("A11", "会话详情页可打开且含正文", async () => {
    const response = await fetch(`${base}/sessions/${SID}`);
    const html = await response.text();
    assertEqual(response.status, 200, "GET /sessions/<id> 状态码");
    assertIncludes(html, SID, "详情页 HTML 中的会话 id");
    assertIncludes(html, MARKER, "详情页 HTML 中的消息正文");
    return `HTTP 200，HTML ${(Buffer.byteLength(html, "utf8") / 1024).toFixed(0)} KB，含会话 id 与正文标记`;
  });

  await checks.check("A12", "落库真相：WAL、行数与唯一性", async () => {
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
      return `WAL；事件 ${counts.events}（投递 ${postedEventIds.size} 条 + 服务端派生的进度事件），turns 1，tool_calls 1，runs 1`;
    } finally {
      db.close();
    }
  });

  await checks.check("A13", "数据隔离：只写临时库", async () => {
    assert(existsSync(join(dataDir, "observer.db")), "临时目录里没有 observer.db");
    assert(existsSync(join(dataDir, "token")), "临时目录里没有 token");
    const list = await getJson(`${base}/api/sessions`);
    assertEqual(list.json.count, 1, "隔离库里的会话数");
    assertEqual(list.json.sessions[0].session_id, SID, "隔离库里的会话 id");
    const realDb = join(REPO, "data", "observer.db");
    return `写入 ${join(dataDir, "observer.db")}；仓库里的 ${realDb} 是否参与：${existsSync(realDb) ? "存在但未被本次验收写入" : "不存在"}`;
  });

  // ── 档 A 续：M2-2 回填入库 ────────────────────────────────────────────────
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
    // 顺便把「不带令牌被拒」这条判据记下来，稍后在 A16 里断言。
    const denied = await fetch(`${bfBase}/api/backfill`, { method: "POST" });
    const deniedStatus = denied.status;
    const bfToken = await readToken(bfDataDir);

    await checks.check("A14", "启动扫描：事先存在的会话文件已入库，字段与文件一致", async () => {
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

        const tool = db.prepare("SELECT * FROM tool_calls WHERE tool_call_id = 'bf-call-1'").get();
        assert(tool !== undefined && tool !== null, "库里没有 bf-call-1 的工具调用");
        assertEqual(tool.tool_name, "bash", "tool_name");
        assertEqual(JSON.parse(tool.args).command, "echo hi", "工具参数");
        assertEqual(tool.is_error, 0, "is_error");
        assertEqual(tool.duration_ms, 9, "duration_ms（来自工具结果条目）");

        assertEqual(db.prepare("SELECT COUNT(*) AS n FROM jsonl_files").get().n, 1, "jsonl_files 行数");

        const log = bfServer.tailLog(40);
        assertIncludes(log, "启动扫描完成", "服务端日志里的启动扫描记录");
        return `4 条条目 / 1 个 turn / 1 次工具调用入库；来源 backfill，state 保持 idle，日志含启动扫描`;
      } finally {
        db.close();
      }
    });

    await checks.check("A15", "进页面补读：页面请求会把启动之后新增的内容补上", async () => {
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

      // 先确认这一条还没入库——否则下面的断言说明不了是页面触发的
      const before = await openTempDb(bfDataDir);
      const beforeCount = before.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
      before.close();
      assertEqual(beforeCount, 4, "补读之前 messages 行数");

      const response = await fetch(`${bfBase}/sessions/${BF_SID}`);
      const html = await response.text();
      assertEqual(response.status, 200, "GET /sessions/<回填会话> 状态码");
      assertIncludes(html, BF_SID, "详情页 HTML 中的会话 id");
      assertIncludes(html, BF_CWD, "详情页 HTML 中的工作目录");

      const db = await openTempDb(bfDataDir);
      try {
        assertEqual(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 5, "补读之后 messages 行数");
        assertEqual(db.prepare("SELECT COUNT(*) AS n FROM turns").get().n, 2, "补读之后 turns 行数");
        const session = db.prepare("SELECT message_count, turn_count, tokens_in FROM sessions WHERE session_id = ?").get(BF_SID);
        assertEqual(session.message_count, 4, "补读之后 message_count");
        assertEqual(session.turn_count, 2, "补读之后 turn_count");
        assertEqual(session.tokens_in, 16, "补读之后 tokens_in");
        return `页面请求前 4 条 → 请求后 5 条条目 / 2 个 turn，且页面返回 200`;
      } finally {
        db.close();
      }
    });

    await checks.check("A16", "手动触发回填：要令牌、幂等、没变的文件跳过", async () => {
      assertEqual(deniedStatus, 401, "不带令牌触发回填的状态码");

      const first = await fetch(`${bfBase}/api/backfill`, {
        method: "POST",
        headers: { "x-observer-token": bfToken },
      });
      const firstJson = await first.json();
      assertEqual(first.status, 200, "带令牌触发回填的状态码");
      assertEqual(firstJson.ok, true, "回填响应 ok");
      assertEqual(firstJson.summary.files, 1, "扫到的文件数");
      assertEqual(firstJson.summary.skipped, 1, "本次应跳过 1 个文件（A15 已经读过）");
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

    // ── 档 A 续：M2-3 消息树 ────────────────────────────────────────────────
    // 树用「索引行」渲染（不带 payload），点开某个节点才按需取全文。
    await checks.check("A17", "消息树索引：只给索引行，父子关系与文件一致", async () => {
      const list = await getJson(`${bfBase}/api/sessions/${BF_SID}/messages`);
      assertEqual(list.status, 200, "索引接口状态码");
      assertEqual(list.json.count, 5, "索引行数（A15 又追加了一条助手条目）");
      assertEqual(list.json.total, 5, "条目总数（没有截断）");

      const rows = list.json.messages;
      assertEqual(
        rows.map((r) => r.entry_id).join(","),
        "bf-m1,bf-u1,bf-a1,bf-t1,bf-a2",
        "条目按文件行号排序",
      );
      assertEqual(rows[0].kind, "model_change", "第一条条目的 kind");
      assertEqual(rows[1].parent_id, null, "用户条目的 parent_id（文件里就是 null）");
      assertEqual(rows[2].parent_id, "bf-u1", "助手条目的 parent_id");
      assertEqual(rows[3].parent_id, "bf-a1", "工具结果条目的 parent_id");
      assertEqual(rows[4].parent_id, "bf-t1", "补读进来的助手条目的 parent_id");
      assert(rows.every((r) => r.payload === undefined), "索引行里不该带 payload（全文要点开才取）");
      assertIncludes(rows[1].summary, BF_MARKER, "索引摘要含用户正文");
      assert(rows[1].summary.length <= 200, `摘要该截到 200 字符，实际 ${rows[1].summary.length}`);
      assert(rows[2].payload_bytes > 0, "助手条目应记录 payload 字节数");
      return `5 条索引行；父链 bf-u1(根) → bf-a1 → bf-t1 → bf-a2，bf-m1 自成一个根；行内无 payload`;
    });

    await checks.check("A18", "点开节点取全文；页面首屏已经把树渲染出来", async () => {
      const detail = await getJson(`${bfBase}/api/sessions/${BF_SID}/messages?entry=bf-a1`);
      assertEqual(detail.status, 200, "单条详情接口状态码");
      assertEqual(detail.json.message.entry_id, "bf-a1", "详情条目 id");
      assertEqual(detail.json.message.kind, "message", "详情条目 kind");
      assertEqual(detail.json.message.role, "assistant", "详情条目 role");
      assertEqual(detail.json.message.payload.message.role, "assistant", "原始条目 JSON 里的 role");
      assertEqual(detail.json.message.payload.message.usage.input, 11, "原始条目 JSON 里的 tokens_in");
      assert((detail.json.message.text ?? "").length > 0, "详情该带正文摘要");

      const missing = await fetch(`${bfBase}/api/sessions/${BF_SID}/messages?entry=bf-nope`);
      assertEqual(missing.status, 404, "取不存在的条目应 404");

      const page = await fetch(`${bfBase}/sessions/${BF_SID}`);
      const html = await page.text();
      assertEqual(page.status, 200, "详情页状态码");
      assertIncludes(html, "消息树", "页面里有消息树面板");
      assertIncludes(html, "node-line", "页面里有树节点");
      assertIncludes(html, BF_MARKER, "树节点上能看到用户正文");
      assertIncludes(html, "off-branch", "不在当前分支上的条目被标出来（bf-m1 的 parentId 是空的，自成一根）");
      assertIncludes(html, "5 条条目", "面板头给出条目数");
      return `单条接口给出原始条目（role 与 tokens 与文件一致），不存在的条目 404；首屏 HTML 含树、正文与分支标记`;
    });

    // ── 档 A 续：M2-4 会话列表页 ────────────────────────────────────────────
    await checks.check("A19", "会话列表：按项目分组、摘要取首条用户消息、回填会话标「未对账」", async () => {
      const api = await getJson(`${bfBase}/api/sessions`);
      assertEqual(api.status, 200, "列表接口状态码");
      assertEqual(api.json.total, 1, "库里的会话总数");
      assertEqual(api.json.count, 1, "列表行数");

      const row = api.json.sessions[0];
      assertIncludes(row.first_user_text ?? "", BF_MARKER, "列表行要带首条用户消息摘要");
      assertEqual(row.source, "backfill", "来源仍是 backfill");

      const stats = api.json.stats;
      for (const key of [
        "events_today",
        "tokens_in_today",
        "tokens_out_today",
        "dropped_total",
        "unreconciled_sessions",
      ]) {
        assertEqual(typeof stats[key], "number", `概览指标 ${key} 该是数字`);
      }
      assertEqual(stats.unreconciled_sessions, 1, "概览里的未对账会话数");

      const page = await fetch(`${bfBase}/`);
      const html = await page.text();
      assertEqual(page.status, 200, "列表页状态码");
      assertIncludes(html, BF_CWD, "分组头上的项目路径");
      assertIncludes(html, BF_MARKER, "行里的首条用户消息摘要");
      assertIncludes(html, "未对账", "回填会话的状态标记");
      assertIncludes(html, "首条用户消息", "列头说明摘要来源");
      assertIncludes(html, "今日事件", "概览条的指标");
      assertIncludes(html, "共 1 个会话", "页头的会话总数");
      return `1 行：摘要含用户正文、状态标未对账；概览指标齐全且未对账会话数 1`;
    });

    // ── 档 A 续：M2-5 对账与状态推进 ────────────────────────────────────────
    await checks.check("A20", "agent_settled 之后对账：补齐文件里新增的条目，live 变 merged", async () => {
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
        protocol: 2,
        probe_version: "0.1.0",
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

    await checks.check("A21", "session_shutdown：会话推进到已结束，概览里出现核对时间", async () => {
      const posted = await postBatch(bfBase, bfToken, {
        protocol: 2,
        probe_version: "0.1.0",
        dropped_count: 0,
        queue_depth: 0,
        records: [
          {
            kind: "event",
            event_id: "ev-shutdown-1",
            session_id: BF_SID,
            layer: "session",
            event_type: "session_shutdown",
            payload: { reason: "quit", targetSessionFile: null },
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
      assertEqual(list.json.stats.unreconciled_sessions, 0, "对账过的会话不再算未对账");
      assert(list.json.stats.last_reconciled_at !== null, "概览里的最近对账不再是空");
      return `关闭事件 → state ended；列表已不再是「未对账」，最近对账 ${list.json.stats.last_reconciled_at}`;
    });

    // ── 档 A 续：M2-6 会话文件被截短（模拟重写）────────────────────────────
    await checks.check("A22", "文件被截短：识别为重写并从头重读，不产生重复条目", async () => {
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

    // ── 档 A 续：M3-1 模型请求采集 ───────────────────────────────────────
    await checks.check("A23", "模型请求：payload 脱敏、原始字节数、响应状态与 headers 落库", async () => {
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
        protocol: 2,
        probe_version: "0.2.0",
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
        protocol: 2,
        probe_version: "0.2.0",
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

    // ── 档 A 续：M3-3 请求列表与详情 ─────────────────────────────────────
    await checks.check("A24", "请求列表与详情：token / 成本按 run_seq + turn_index 关联，payload 和 headers 按需取", async () => {
      const postedTurn = await postBatch(bfBase, bfToken, {
        protocol: 2,
        probe_version: "0.2.0",
        dropped_count: 0,
        queue_depth: 0,
        records: [
          {
            kind: "turn",
            session_id: BF_SID,
            run_seq: 9,
            turn_index: 1,
            message_entry_id: "accept-request-turn-1",
            started_at: "2026-10-19T08:10:00.000Z",
            ended_at: "2026-10-19T08:10:01.000Z",
            stop_reason: "stop",
            thinking_level: "off",
            assistant_message: {
              role: "assistant",
              content: [{ type: "text", text: "请求对应 Turn 的助手消息" }],
              usage: { input: 111, output: 222, cacheRead: 33, cacheWrite: 44, cost: { total: 0.043 } },
            },
            tool_results: [],
            tokens_in: 111,
            tokens_out: 222,
            cost: 0.043,
          },
        ],
      });
      assertEqual(postedTurn.status, 200, "写入关联 Turn 的状态码");

      const list = await getJson(`${bfBase}/api/sessions/${BF_SID}/requests`);
      assertEqual(list.status, 200, "请求列表接口状态码");
      assertEqual(list.json.total, 1, "请求总数");
      assertEqual(list.json.count, 1, "请求列表行数");
      const row = list.json.requests[0];
      assertEqual(row.request_seq, 1, "请求序号");
      assertEqual(row.run_seq, 9, "列表行带 run_seq");
      assertEqual(row.turn_index, 1, "列表行带 turn_index");
      assertEqual(row.tokens_in, 111, "输入 token 来自关联 Turn");
      assertEqual(row.tokens_out, 222, "输出 token 来自关联 Turn");
      assertEqual(row.cost, 0.043, "成本来自关联 Turn");
      assert(row.payload === undefined, "列表行不带 payload");
      assert(row.response_headers === undefined, "列表行不带响应头");

      const detail = await getJson(`${bfBase}/api/sessions/${BF_SID}/requests?seq=1`);
      assertEqual(detail.status, 200, "请求详情接口状态码");
      const request = detail.json.request;
      assertEqual(request.payload.authorization, "[redacted]", "详情里的 payload 已脱敏");
      assertIncludes(request.payload.messages[0].content, "ACCEPT-REQUEST", "详情保留正文");
      assertEqual(request.response_headers["x-ds-trace-id"], "trace-accept", "详情带响应头");
      assertEqual(request.response_headers.authorization, "[redacted]", "响应头凭据已脱敏");
      assertEqual(request.correlation, "serial_assumed", "关联方式");
      assertEqual(request.turn_usage.cacheRead, 33, "usage 来自关联 Turn 的助手消息");
      assertEqual(request.turn_usage.cacheWrite, 44, "缓存写入");
      assertEqual(request.turn_usage.cost.total, 0.043, "usage 里的成本明细");

      const cursor = await getJson(`${bfBase}/api/sessions/${BF_SID}/cursor`);
      assertEqual(cursor.status, 200, "会话游标接口状态码");
      assertEqual(cursor.json.request_seq_max, 1, "库里已用的最大请求序号");
      assertEqual(cursor.json.run_seq_max, 9, "库里已用的最大运行序号");

      const missing = await fetch(`${bfBase}/api/sessions/${BF_SID}/requests?seq=999`);
      assertEqual(missing.status, 404, "不存在的请求 404");
      const badSeq = await fetch(`${bfBase}/api/sessions/${BF_SID}/requests?seq=abc`);
      assertEqual(badSeq.status, 400, "非法 seq 400");

      const sessionPage = await fetch(`${bfBase}/sessions/${BF_SID}`);
      const sessionHtml = await sessionPage.text();
      assertEqual(sessionPage.status, 200, "会话详情页状态码");
      assertIncludes(sessionHtml, "时间线", "标签条里有时间线");
      assertIncludes(sessionHtml, "请求", "标签条里有请求");
      assertIncludes(sessionHtml, "accept-model", "请求行显示模型");
      assertIncludes(sessionHtml, `/sessions/${BF_SID}/requests/1`, "请求行链到详情页");

      const requestPage = await fetch(`${bfBase}/sessions/${BF_SID}/requests/1`);
      const requestHtml = await requestPage.text();
      assertEqual(requestPage.status, 200, "请求详情页状态码");
      assertIncludes(requestHtml, "Payload", "详情页有 payload 标签");
      assertIncludes(requestHtml, "ACCEPT-REQUEST", "首屏就带 payload 预览");
      assertIncludes(requestHtml, "[redacted]", "首屏显示的是脱敏后的值");
      assertIncludes(requestHtml, "111", "首屏有输入 token");
      assertIncludes(requestHtml, "0.04", "首屏有成本");

      return `列表 1 行：token 111 / 222、成本 0.043 来自关联 Turn；详情有脱敏 payload 与响应头；页面与接口 200，缺请求 404、非法 seq 400`;
    });
  } finally {
    await bfServer.stop();
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
