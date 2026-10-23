"use client";

import { useEffect, useState } from "react";

import type { ProbeStatusRow } from "@/lib/types.ts";
import { useNow, useStreamEvent, useStreamStatus } from "./hooks.ts";
import type { StreamStatus } from "./stream-client.ts";

/** `/api/health` 里的 recent_problems：只保留自己需要的字段 */
export interface ProbeProblem {
  ts: string;
  level: string;
  scope: string;
  msg: string;
  /** 具体原因在 extra 里（ingest 写的是 extra.error / extra.reason） */
  extra?: Record<string, unknown>;
}

export interface ProbeView {
  probe: ProbeStatusRow | null;
  /** 到看板服务的 SSE 连接状态（三态，页面刚加载时是 connecting） */
  stream: StreamStatus;
  /** 探针是否在最近 15 秒内推过数据 */
  live: boolean;
  subscribers: number;
  /** 服务实际监听的地址（桌面版端口是随机的，不能写死） */
  baseUrl: string | null;
  /** 服务端最近的 warn / error（例如批次被拒的原因） */
  problems: ProbeProblem[];
}

const STALE_MS = 15000;

export function useProbeStatus(): ProbeView {
  const [probe, setProbe] = useState<ProbeStatusRow | null>(null);
  const [subscribers, setSubscribers] = useState(0);
  const [problems, setProblems] = useState<ProbeProblem[]>([]);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const stream = useStreamStatus();
  const now = useNow(1000);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((response) => response.json())
      .then((json: { probe?: ProbeStatusRow | null; subscribers?: number; recent_problems?: ProbeProblem[]; base_url?: string }) => {
        if (cancelled) return;
        setProbe(json.probe ?? null);
        setSubscribers(json.subscribers ?? 0);
        setProblems(json.recent_problems ?? []);
        setBaseUrl(typeof json.base_url === "string" ? json.base_url : null);
      })
      .catch(() => {
        // 服务暂不可达时保持空状态
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useStreamEvent((event, data) => {
    if (event !== "probe.status") return;
    if (typeof data.connected === "boolean") return; // 连接确认帧，不含真实状态
    setProbe((previous) => ({
      last_seen_at: typeof data.last_seen_at === "string" ? data.last_seen_at : (previous?.last_seen_at ?? null),
      dropped_count: typeof data.dropped_count === "number" ? data.dropped_count : (previous?.dropped_count ?? 0),
      queue_depth: typeof data.queue_depth === "number" ? data.queue_depth : (previous?.queue_depth ?? 0),
      probe_version: typeof data.probe_version === "string" ? data.probe_version : (previous?.probe_version ?? null),
    }));
  });

  const live = probe?.last_seen_at ? now - Date.parse(probe.last_seen_at) < STALE_MS : false;

  return { probe, stream, live, subscribers, baseUrl, problems };
}
