import { config } from "@/lib/config.ts";
import { HEARTBEAT_FRAME, encodeFrame, subscribe } from "@/lib/sse.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE（技术选型 T5 / 附录 C.3：实测 dev 与 start 都逐帧即时刷新）。
 * 载荷只带标识与版本号，页面按需二次拉取（PRD §10）。
 */
export async function GET(req: Request): Promise<Response> {
  const cfg = config();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      send(`: pi-observer 已连接\n\n`);
      send(encodeFrame("probe.status", { connected: true }));

      const unsubscribe = subscribe((event) => {
        send(encodeFrame(event.event, event.data));
      });

      const heartbeat = setInterval(() => send(HEARTBEAT_FRAME), cfg.sseHeartbeatMs);

      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // 已经关闭
        }
      };

      // 浏览器关闭页面 / 服务退出都会触发
      req.signal.addEventListener("abort", shutdown);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
