"use client";

import { useEffect, useRef, useState } from "react";

import { subscribeStatus, subscribeStream, type StreamStatus } from "./stream-client.ts";

/** 每秒跳一次的「现在」，用于相对时间实时刷新 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 订阅 SSE 事件；handler 每次都取最新的那个，避免频繁重订阅 */
export function useStreamEvent(handler: (event: string, data: Record<string, unknown>) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeStream((event, data) => ref.current(event, data)), []);
}

export function useStreamStatus(): StreamStatus {
  const [value, setValue] = useState<StreamStatus>("connecting");
  useEffect(() => subscribeStatus(setValue), []);
  return value;
}
