/**
 * 用途：测量 message_update 的实际触发频率（对应 docs/durable-feasibility.md 的 H3）。
 *
 * 用法：
 *   pi --extension ./probes/message-update-rate.ts
 *
 * 然后在会话里正常提一个会触发流式输出的请求。每轮结束（agent_settled）会打印一行统计：
 *   message_update: <次数> / <毫秒> → <次每秒>
 *
 * 注意事项（来自 Pi 的扩展契约）：
 * - 不在 factory 里启动任何进程、socket 或定时器；
 * - 只计数，不发起网络请求，不阻塞流；
 * - 不返回任何值，避免影响 agent 的后续行为。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let count = 0;
  let firstAt = 0;
  let lastAt = 0;

  pi.on("message_update", () => {
    const now = Date.now();
    if (firstAt === 0) firstAt = now;
    lastAt = now;
    count += 1;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (count === 0) return;
    const elapsedMs = Math.max(lastAt - firstAt, 1);
    const perSecond = (count / (elapsedMs / 1000)).toFixed(1);
    const line = `message_update: ${count} 次 / ${elapsedMs} ms → ${perSecond} 次每秒`;
    count = 0;
    firstAt = 0;
    lastAt = 0;
    if (ctx.hasUI) {
      await ctx.ui.notify(line, "info");
    } else {
      console.error(`[message-update-rate] ${line}`);
    }
  });
}
