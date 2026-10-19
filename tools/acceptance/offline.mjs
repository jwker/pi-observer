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
import { existsSync, rmSync } from "node:fs";
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
  protocol: 1,
  probe_version: "accept-offline",
  dropped_count: 0,
  queue_depth: 0,
  records,
});

const dataDir = makeTempDir();
const port = await freePort();
const checks = new Checks("离线验收（档 A）");
/** 我主动投递过的 event_id，最后用来核对库里没有多也没有少 */
const postedEventIds = new Set();
const track = (id) => {
  postedEventIds.add(id);
  return id;
};

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
    assertEqual(health.protocol, 1, "protocol");
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
    rmSync(dataDir, { recursive: true, force: true });
  } else {
    console.log(`· 临时目录保留在 ${dataDir}（服务端日志：${server?.logPath ?? "-"}）`);
  }
}
