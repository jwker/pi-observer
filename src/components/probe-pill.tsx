"use client";

import { relativeTime } from "@/lib/format.ts";
import { useNow } from "./hooks.ts";
import { useProbeStatus } from "./use-probe-status.ts";

/** 顶栏右侧的探针状态胶囊（PRD §11：探针连接状态一眼可辨） */
export function ProbePill() {
  const { probe, stream, live } = useProbeStatus();
  const now = useNow(1000);

  const variant = stream === "connecting" ? "pending" : stream === "error" ? "bad" : live ? "" : "offline";
  const text =
    stream === "connecting"
      ? "连接看板服务中…"
      : stream === "error"
        ? "看板服务连接中断"
        : live
          ? `探针已连接 · ${relativeTime(probe?.last_seen_at ?? null, now)}`
          : probe
            ? `探针静默 · ${relativeTime(probe.last_seen_at, now)}`
            : "尚未收到探针数据";

  return (
    <span className={`probe-pill ${variant}`} title="探针最近一次推送时间；静默超过 15 秒即视为未连接">
      <span className="pulse" />
      {text}
    </span>
  );
}
