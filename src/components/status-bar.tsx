"use client";

import { relativeTime } from "@/lib/format.ts";
import { useNow } from "./hooks.ts";
import { useProbeStatus } from "./use-probe-status.ts";

/** 底部状态栏：探针连接、最近推送、队列深度、累计丢弃（对应原型状态栏） */
export function StatusBar() {
  const { probe, stream, live, problems } = useProbeStatus();
  const now = useNow(1000);
  const dropped = probe?.dropped_count ?? 0;

  const dotColor = stream === "connecting" ? "var(--fg-3)" : stream === "error" ? "var(--red)" : live ? "var(--green)" : "var(--amber)";
  const label =
    stream === "connecting" ? "连接看板服务中…" : stream === "error" ? "看板服务连接中断" : live ? "探针已连接" : "探针静默";

  // 服务端拒批原因只写 stderr，浏览器看不到；这里显示最近一条，
  // 否则探针那边「批次被拒绝，已丢弃 N 条」在页面上没有任何对应信息。
  const lastProblem = problems[problems.length - 1] ?? null;
  // 原因在 extra 里（ingest 记的是 extra.error / extra.reason），挨个取第一个字符串值
  const problemReason = lastProblem
    ? Object.values(lastProblem.extra ?? {}).find((value): value is string => typeof value === "string")
    : undefined;
  const problemText = lastProblem
    ? `${lastProblem.msg}${problemReason ? `：${problemReason}` : ""}`
    : "";

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
        {lastProblem ? (
          <span className="item" style={{ color: "var(--red)" }} title={`${lastProblem.ts} ${lastProblem.scope}`}>
            最近拒批 {relativeTime(lastProblem.ts, now)} · {problemText}
          </span>
        ) : null}
        <span className="spacer" />
        <span className="item faint">数据仅存本机 127.0.0.1:4173</span>
      </div>
    </div>
  );
}
