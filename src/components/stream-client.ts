"use client";

/**
 * 浏览器侧共享一条 SSE 连接（多个组件订阅同一 EventSource，避免开多路连接）。
 * 断线由 `EventSource` 自己重连；这里只广播连接状态。
 *
 * 状态是三态而不是布尔：页面刚加载、连接还没建立时报「连接中断」是误导，
 * 那时应该显示「连接中…」。
 */

export type StreamStatus = "connecting" | "open" | "error";

type StreamHandler = (event: string, data: Record<string, unknown>) => void;
type StatusHandler = (status: StreamStatus) => void;

const EVENT_NAMES = ["session.updated", "turn.updated", "tool.updated", "event.appended", "probe.status"] as const;

const handlers = new Set<StreamHandler>();
const statusHandlers = new Set<StatusHandler>();

let source: EventSource | null = null;
let status: StreamStatus = "connecting";

function setStatus(next: StreamStatus): void {
  if (status === next) return;
  status = next;
  for (const handler of statusHandlers) {
    try {
      handler(next);
    } catch {
      // 单个订阅者出错不影响其他订阅者
    }
  }
}

function ensureSource(): void {
  if (typeof window === "undefined" || source !== null) return;

  const es = new EventSource("/api/stream");
  source = es;

  es.onopen = () => setStatus("open");
  es.onerror = () => setStatus("error");

  for (const name of EVENT_NAMES) {
    es.addEventListener(name, (event) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse((event as MessageEvent).data) as Record<string, unknown>;
      } catch {
        data = {};
      }
      // 收到任何命名事件都说明连接是活的
      setStatus("open");
      for (const handler of handlers) {
        try {
          handler(name, data);
        } catch {
          // 同上
        }
      }
    });
  }
}

export function subscribeStream(handler: StreamHandler): () => void {
  ensureSource();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function subscribeStatus(handler: StatusHandler): () => void {
  ensureSource();
  statusHandlers.add(handler);
  handler(status);
  return () => {
    statusHandlers.delete(handler);
  };
}
