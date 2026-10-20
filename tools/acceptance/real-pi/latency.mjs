/**
 * 档 B：端到端「发生 → 页面上可见」延迟（PRD §14 M1 第 1 条，判据：2 秒内）。
 *
 * 前置：
 *   1. 真实服务端在跑：`npm run start`（默认 4173）；
 *   2. 探针已装进一个真实 Pi 会话（`pi --extension ./ext`）。
 *
 * 用法：
 *   node tools/acceptance/real-pi/latency.mjs [cwd 关键字] [测量秒数]
 *   默认：cwd 含 "pi-observer" 的会话，测 30 秒。
 *
 * 说明：只读接口，不调用模型、不花钱；但测量期间需要你（或另一条命令）真的在跟 Pi 对话，
 * 否则没有新事件可测。服务端地址可用 `PI_OBSERVER_URL` 覆盖。
 */
const target = process.argv[2] ?? "pi-observer";
const durationMs = Number(process.argv[3] ?? 30000);
const base = process.env.PI_OBSERVER_URL ?? "http://127.0.0.1:4173";

const visible = new Map();
let sessionId = null;
const startedAt = Date.now();

for (;;) {
  try {
    if (!sessionId) {
      const sessions = (await (await fetch(`${base}/api/sessions`)).json()).sessions ?? [];
      const match = sessions.find((session) => String(session.cwd).includes(target));
      if (match) sessionId = match.session_id;
    }
    if (sessionId) {
      const payload = await (await fetch(`${base}/api/session?id=${sessionId}`)).json();
      const events = payload.data?.events ?? [];
      for (const event of events) {
        if (!visible.has(event.event_id)) visible.set(event.event_id, { at: Date.now(), occurredAt: event.occurred_at });
      }
    }
  } catch {
    // 服务短暂不可达时继续
  }
  if (Date.now() - startedAt > durationMs) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const lags = [...visible.values()]
  .map((item) => ({ ...item, lag: Date.parse(item.occurredAt) ? item.at - Date.parse(item.occurredAt) : null }))
  .filter((item) => item.lag !== null)
  .sort((a, b) => b.lag - a.lag);

console.log(`服务端: ${base}`);
console.log(`会话: ${sessionId ?? "(未发现含该关键字的会话)"}`);
console.log(`事件总数: ${visible.size}，可算延迟的: ${lags.length}`);
if (lags.length === 0) {
  console.log("没有可算延迟的事件——测量期间需要有真实事件发生。");
} else {
  const median = lags[Math.floor(lags.length / 2)].lag;
  console.log(`最大延迟: ${lags[0].lag} ms`);
  console.log(`中位延迟: ${median} ms`);
  console.log("最慢 3 条:", lags.slice(0, 3).map((item) => `${item.lag}ms`).join(", "));
  console.log(`判据（≤ 2000 ms）：最大延迟 ${lags[0].lag <= 2000 ? "通过" : "不通过"}`);
  console.log("注意：这里的延迟含探针的批量间隔（默认 300 ms）与页面轮询间隔（100 ms），不是单次网络耗时。");
}
