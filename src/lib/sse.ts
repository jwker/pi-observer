/**
 * 服务 → 浏览器的单向推送（技术选型 T5）。
 * 只用内存订阅表，不查库；每批写入完成后广播一次（PRD §8.4）。
 */

export type SseEventName =
  | "session.updated"
  | "turn.updated"
  | "tool.updated"
  | "event.appended"
  | "probe.status";

export interface SseEvent {
  event: SseEventName;
  data: Record<string, unknown>;
}

type Subscriber = (event: SseEvent) => void;

const GLOBAL_KEY = "__piObserverSseSubscribers";

function registry(): Set<Subscriber> {
  const g = globalThis as unknown as Record<string, Set<Subscriber> | undefined>;
  g[GLOBAL_KEY] ??= new Set<Subscriber>();
  return g[GLOBAL_KEY] as Set<Subscriber>;
}

export function subscribe(fn: Subscriber): () => void {
  const set = registry();
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

export function broadcast(event: SseEventName, data: Record<string, unknown>): void {
  for (const fn of registry()) {
    try {
      fn({ event, data });
    } catch {
      // 单个订阅者出错不影响其他订阅者
    }
  }
}

export function subscriberCount(): number {
  return registry().size;
}

/** 测试用：清空订阅表 */
export function clearSubscribers(): void {
  registry().clear();
}

/** SSE 帧格式（已实测 `curl -N` 可逐帧收到） */
export function encodeFrame(event: SseEventName, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 注释心跳，防止长连接被中间层回收 */
export const HEARTBEAT_FRAME = ": ping\n\n";
