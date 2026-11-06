"use client";

import { useEffect, useState } from "react";

import { dateTime } from "@/lib/format.ts";
import type { StreamRow } from "@/lib/stream.ts";
import type { EntryDetail } from "@/lib/types.ts";

export interface DetailTarget {
  sessionId: string;
  row: StreamRow;
}

/** 行详情弹窗：会话文件里这一条条目的原文。 */
export function RowDetailModal({ target, onClose }: { target: DetailTarget; onClose: () => void }) {
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = `/api/detail?session=${encodeURIComponent(target.sessionId)}&id=${encodeURIComponent(
      target.row.entryId ?? "",
    )}`;
    fetch(url)
      .then(async (response) => {
        const json = (await response.json()) as { ok?: boolean; detail?: EntryDetail; error?: string };
        if (cancelled) return;
        if (json.ok === false || json.detail === undefined) {
          setError(json.error ?? "读不到这一条");
          return;
        }
        setDetail(json.detail);
      })
      .catch(() => {
        if (!cancelled) setError("读不到这一条");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target.sessionId, target.row.entryId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-label">条目详情</span>
          <span className="modal-meta">
            {target.row.entryId ?? "—"}
            {target.row.at !== null ? ` · ${dateTime(target.row.at)}` : ""}
          </span>
          <button className="btn ghost x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">
          {loading ? <div className="empty">正在读取…</div> : null}
          {error !== null ? (
            <div className="notice err">
              <span className="ic">!</span>
              <div>{error}</div>
            </div>
          ) : null}
          {detail !== null ? (
            <>
              {detail.tool !== null ? (
                <div className="panel">
                  <div className="panel-head">
                    <span className="modal-label">工具调用</span>
                    <span className="count">{detail.tool.tool_name}</span>
                  </div>
                  <div className="panel-body">
                    <div className="kv">
                      <span>调用 id</span>
                      <b>{detail.tool.tool_call_id}</b>
                    </div>
                    <div className="kv">
                      <span>结果</span>
                      <b>{detail.tool.is_error ? "失败" : "成功"}</b>
                    </div>
                    {detail.tool.duration_ms !== null ? (
                      <div className="kv">
                        <span>耗时</span>
                        <b>{detail.tool.duration_ms} ms</b>
                      </div>
                    ) : null}
                    {detail.tool.args !== null ? (
                      <pre className="pre">{JSON.stringify(detail.tool.args, null, 2)}</pre>
                    ) : null}
                    {detail.tool.result !== null ? (
                      <pre className="pre">{JSON.stringify(detail.tool.result, null, 2)}</pre>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="panel">
                <div className="panel-head">
                  <span className="modal-label">原始条目</span>
                  <span className="count">{detail.kind}</span>
                </div>
                <div className="panel-body">
                  <pre className="pre">{JSON.stringify(detail.raw, null, 2)}</pre>
                </div>
              </div>
            </>
          ) : null}
        </div>
        <div className="modal-foot">
          <span className="faint">数据来自会话文件；provider 请求正文不在这里，去 iCloud 的请求目录里看。</span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
