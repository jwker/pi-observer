import assert from "node:assert/strict";
import test from "node:test";

import { createFlusher } from "../ext/flush.ts";
import { BoundedQueue } from "../ext/queue.ts";
import { PROBE_PROTOCOL_VERSION, type IngestRecord } from "../src/lib/protocol.ts";

const sizeOf = (record: IngestRecord): number => Buffer.byteLength(JSON.stringify(record), "utf8");

function makeEvent(id: string): IngestRecord {
  return {
    kind: "event",
    event_id: id,
    session_id: "s1",
    layer: "agent",
    event_type: "agent_start",
    payload: { id },
    occurred_at: "2026-10-19T10:00:00.000Z",
    run_seq: 1,
    turn_index: 0,
  };
}

function makeQueue(count: number): BoundedQueue<IngestRecord> {
  const queue = new BoundedQueue<IngestRecord>(sizeOf, { maxRecords: 1000, maxBytes: 4 * 1024 * 1024 });
  for (let i = 0; i < count; i += 1) queue.push(makeEvent(`e${i}`));
  return queue;
}

interface Harness {
  flusher: ReturnType<typeof createFlusher>;
  queue: BoundedQueue<IngestRecord>;
  sent: IngestRecord[][];
  logs: string[];
}

function harness(options: {
  queue: BoundedQueue<IngestRecord>;
  outcome?: () => { ok: true; applied: Record<string, number> } | { ok: false; retryable: boolean; reason: string };
  token?: string | null;
  now?: () => number;
  maxBatchRecords?: number;
  maxBatchBytes?: number;
}): Harness {
  const sent: IngestRecord[][] = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  const readNow = options.now ?? (() => clock);

  const flusher = createFlusher({
    queue: options.queue,
    ingestUrl: "http://127.0.0.1:4173/api/ingest",
    token: () => (options.token === undefined ? "token" : options.token),
    rejectedCount: () => 0,
    maxBatchRecords: options.maxBatchRecords ?? 200,
    maxBatchBytes: options.maxBatchBytes ?? 1024 * 1024,
    log: (message) => logs.push(message),
    now: () => readNow(),
    post: async (input) => {
      sent.push(input.batch.records);
      clock += 10;
      return options.outcome ? options.outcome() : { ok: true, applied: {} };
    },
  });

  return { flusher, queue: options.queue, sent, logs };
}

test("成功一批后清空队列并重置退避", async () => {
  const queue = makeQueue(5);
  const { flusher, sent } = harness({ queue });

  assert.equal(await flusher.flush(), true);
  assert.equal(queue.depth, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 5);
  assert.equal(flusher.attempt(), 0);
  assert.equal(flusher.nextAttemptAt(), 0);
});

test("可重试失败：记录放回队首、按档位退避、退避窗口内不再发", async () => {
  const queue = makeQueue(3);
  const { flusher, sent, logs } = harness({
    queue,
    outcome: () => ({ ok: false, retryable: true, reason: "fetch failed" }),
  });

  assert.equal(await flusher.flush(), false);
  assert.equal(queue.depth, 3, "失败批必须原样放回");
  assert.equal(flusher.attempt(), 1);
  assert.ok(flusher.nextAttemptAt() > 0);
  assert.match(logs[0], /推送失败，1000ms 后重试/);

  // 第二次调用落在退避窗口里 → 直接返回，不发
  assert.equal(await flusher.flush(), false);
  assert.equal(sent.length, 1, "退避窗口内不该再发");
});

test("毒批（4xx）：丢弃并继续，不反复重放", async () => {
  const queue = makeQueue(2);
  const { flusher, sent, logs } = harness({
    queue,
    outcome: () => ({ ok: false, retryable: false, reason: "HTTP 413" }),
  });

  assert.equal(await flusher.flush(), true);
  assert.equal(queue.depth, 0, "毒批要丢掉，避免卡住整个队列");
  assert.equal(flusher.attempt(), 0, "毒批不计入退避");
  assert.match(logs[0], /批次被拒绝，已丢弃 2 条/);
  assert.equal(sent.length, 1);
});

test("令牌还没生成时不空转，按退避重试", async () => {
  const queue = makeQueue(1);
  const { flusher, sent } = harness({ queue, token: null });

  assert.equal(await flusher.flush(), false);
  assert.equal(sent.length, 0);
  assert.equal(queue.depth, 1);
  assert.equal(flusher.attempt(), 1);
});

test("按字节装车：单批不超过上限，剩下的下一批发", async () => {
  const queue = makeQueue(10);
  const { flusher, sent } = harness({ queue, maxBatchRecords: 100, maxBatchBytes: 500 });

  await flusher.flush();
  assert.equal(sent[0].length > 0 && sent[0].length < 10, true, "字节上限应切出小于全量的批");
  assert.ok(
    Buffer.byteLength(JSON.stringify(sent[0]), "utf8") <= 500 + 160,
    "一批的字节数不该明显超过上限（单条超限时允许带走一条）",
  );

  for (let i = 0; i < 20 && queue.depth > 0; i += 1) await flusher.flush();
  assert.equal(queue.depth, 0);
});

test("回归：处在退避窗口里时，收尾排空仍必须把积压发出去", async () => {
  // 复现故障现场：服务端不可达 → 退避窗口被推到未来 → 服务端恢复 → Pi 退出
  const queue = makeQueue(4);
  let online = false;
  const { flusher, sent, logs } = harness({
    queue,
    outcome: () => (online ? { ok: true, applied: {} } : { ok: false, retryable: true, reason: "fetch failed" }),
  });

  assert.equal(await flusher.flush(), false, "第一次撞上服务端不可达");
  assert.equal(queue.depth, 4);
  assert.ok(flusher.nextAttemptAt() > 0, "退避窗口已推到未来");

  online = true;
  // 退避窗口内 + 服务端已恢复：普通 flush 会被闸门挡住
  assert.equal(await flusher.flush(), false);
  assert.equal(queue.depth, 4);

  // 收尾排空必须无视退避把 4 条送出去
  const rounds = await flusher.drainWithin(3000);
  assert.ok(rounds >= 1);
  assert.equal(queue.depth, 0, "收尾时不能把积压静默丢掉");
  assert.deepEqual(
    (sent.at(-1) ?? []).map((record) => (record as { event_id: string }).event_id),
    ["e0", "e1", "e2", "e3"],
    "顺序必须保持",
  );
  assert.equal(logs.filter((line) => line.includes("推送失败")).length, 1);
});

test("收尾排空：服务端一直不可达时不死循环、不无限等", async () => {
  const queue = makeQueue(6);
  let clock = 1_000_000;
  const { flusher, sent } = harness({
    queue,
    now: () => clock,
    outcome: () => {
      clock += 500; // 每次尝试都吃掉 500ms 预算
      return { ok: false, retryable: true, reason: "fetch failed" };
    },
  });

  const rounds = await flusher.drainWithin(1000);
  assert.ok(rounds >= 1 && rounds <= 3, `预算内不该无限重试，实际 ${rounds} 轮`);
  assert.ok(sent.length <= 3);
  assert.equal(queue.depth, 6);
});

test("收尾排空：队列为空时立即返回", async () => {
  const queue = makeQueue(0);
  const { flusher, sent } = harness({ queue });
  assert.equal(await flusher.drainWithin(3000), 0);
  assert.equal(sent.length, 0);
});

test("并发 flush 不会重复取走同一批", async () => {
  const queue = makeQueue(4);
  const { flusher, sent } = harness({ queue });
  const results = await Promise.all([flusher.flush(), flusher.flush(), flusher.flush()]);
  assert.equal(sent.length, 1, "同一时刻只允许一批在飞");
  assert.deepEqual(results.filter(Boolean).length, 1);
  assert.equal(queue.depth, 0);
});

test("协议号随批次上报，且带队列深度", async () => {
  const queue = makeQueue(2);
  const seen: Array<{ protocol: number; queue_depth: number; dropped_count: number }> = [];
  const flusher = createFlusher({
    queue,
    ingestUrl: "u",
    token: () => "t",
    rejectedCount: () => 7,
    maxBatchRecords: 200,
    maxBatchBytes: 1024 * 1024,
    log: () => {},
    post: async (input) => {
      seen.push({
        protocol: input.batch.protocol,
        queue_depth: input.batch.queue_depth,
        dropped_count: input.batch.dropped_count,
      });
      return { ok: true, applied: {} };
    },
  });

  await flusher.flush();
  assert.deepEqual(seen[0], { protocol: PROBE_PROTOCOL_VERSION, queue_depth: 0, dropped_count: 7 });
});
