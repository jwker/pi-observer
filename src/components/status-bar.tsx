"use client";

import { relativeTime } from "@/lib/format.ts";
import { useNow } from "./hooks.ts";
import { useProbeStatus } from "./use-probe-status.ts";

/** 底部状态栏：探针连接、最近推送、队列深度、累计丢弃（对应原型状态栏） */
export function StatusBar() {
  const { probe, stream, live } = useProbeStatus();
  const now = useNow(1000);
  const dropped = probe?.dropped_count ?? 0;

  const dotColor = stream === "connecting" ? "var(--fg-3)" : stream === "error" ? "var(--red)" : live ? "var(--green)" : "var(--amber)";
  const label =
    stream === "connecting" ? "连接看板服务中…" : stream === "error" ? "看板服务连接中断" : live ? "探针已连接" : "探针静默";

  return (
    <div className="statusbar">
      <div className="statusbar-inner">
        <span className="item">
          <span className="dot-sm" style={{ color: dotColor }} />
          {label}
        </span>
        <span className="item">
          最近推送 <span style={{ color: "var(--fg)" }}>{relativeTime(probe?.last_seen_at ?? null, now)}</span>
        </span>
        <span className="item">
          队列{" "}
          <span style={{ color: "var(--fg)" }}>
            {probe ? `${probe.queue_depth} / 2000` : "—"}
          </span>
        </span>
        <span className="item">
          累计丢弃{" "}
          <span style={{ color: dropped > 0 ? "var(--err)" : "var(--fg)" }}>{probe ? dropped : "—"}</span>
        </span>
        <span className="item faint">探针版本 {probe?.probe_version ?? "—"}</span>
        <span className="spacer" />
        <span className="item faint">数据仅存本机 127.0.0.1:4173</span>
      </div>
    </div>
  );
}
