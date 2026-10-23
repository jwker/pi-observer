"use client";

import { useEffect, useState } from "react";

import type { DiffBlock } from "@/lib/diff.ts";
import { formatBytes } from "@/lib/format.ts";

interface DiffResponse {
  ok?: boolean;
  hasPrevious?: boolean;
  message?: string;
  added?: number;
  removed?: number;
  current?: { seq: number; bytes: number; model: string | null };
  previous?: { seq: number; bytes: number; model: string | null };
  blocks?: DiffBlock[];
  error?: string;
}

interface RequestDiffProps {
  sessionId: string;
  requestSeq: number;
}

/**
 * 两次模型请求的逐行差异。
 *
 * 对比同一个会话里相邻两次请求的完整请求体（正文在 `data/payloads/` 里）。
 * 服务端算好差异再传过来，浏览器只负责显示。
 */
export function RequestDiff({ sessionId, requestSeq }: RequestDiffProps) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/requests/${requestSeq}/diff`;
    fetch(url, { signal: controller.signal })
      .then((response) => response.json())
      .then((json: DiffResponse) => {
        if (json.ok === false) {
          setError(json.error ?? "取不到差异。");
          return;
        }
        setData(json);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("取不到差异。看板服务可能已经断开。");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [sessionId, requestSeq]);

  if (loading) return <div className="empty">正在比较两次请求…</div>;
  if (error !== null) return <div className="empty">{error}</div>;
  if (data === null) return <div className="empty">没有差异数据。</div>;

  if (data.hasPrevious !== true) {
    return <div className="empty">{data.message ?? "没有可对比的上一条请求。"}</div>;
  }

  return (
    <div className="diff-view">
      <div className="diff-head">
        <span className="mono-dim">
          #{data.previous?.seq} → #{data.current?.seq}
        </span>
        <span className="chip">
          <span className="k">新增</span> {data.added ?? 0} 行
        </span>
        <span className="chip">
          <span className="k">删除</span> {data.removed ?? 0} 行
        </span>
        <span className="faint">
          {formatBytes(data.previous?.bytes ?? 0)} → {formatBytes(data.current?.bytes ?? 0)}
        </span>
      </div>

      <div className="diff-body">
        {(data.blocks ?? []).map((block, index) => {
          if (block.kind === "gap") {
            return (
              <div className="diff-gap" key={index}>
                ⋯ 省略 {block.count} 行未变更内容
              </div>
            );
          }
          return (
            <div className="diff-rows" key={index}>
              {block.rows.map((row, rowIndex) => (
                <div className={`diff-row ${row.type}`} key={rowIndex}>
                  <span className="diff-num">{row.oldLine ?? ""}</span>
                  <span className="diff-num">{row.newLine ?? ""}</span>
                  <span className="diff-mark">
                    {row.type === "added" ? "+" : row.type === "removed" ? "-" : " "}
                  </span>
                  <span className="diff-text">{row.text}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
