"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import { clockTime, formatBytes, formatCost, formatTokens } from "@/lib/format.ts";
import { requestLabel, requestStatusMeta } from "@/lib/request-view.ts";
import type { RequestIndexRow } from "@/lib/types.ts";
import { useStreamEvent } from "./hooks.ts";

interface RequestsProps {
  sessionId: string;
  initialRequests: RequestIndexRow[];
  initialTotal: number;
  /** 总数变化时同步标签上的计数 */
  onTotalChange?: (total: number) => void;
}

/**
 * 请求列表（PRD §11.2 视图二 / M3-3）。
 *
 * 只显示列表行；payload 与 headers 在详情页按需取。实时刷新用 `session.updated`
 * （探针每批写入都会广播），只对当前会话生效；`turn.updated` 到来说明 token / 成本已写入，
 * 也顺带刷新一次。
 */
export function Requests({ sessionId, initialRequests, initialTotal, onTotalChange }: RequestsProps) {
  const [requests, setRequests] = useState<RequestIndexRow[]>(initialRequests);
  const [total, setTotal] = useState(initialTotal);
  const loading = useRef(false);

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/requests?limit=200`);
      if (!response.ok) return;
      const json = (await response.json()) as { requests?: RequestIndexRow[]; total?: number };
      if (json.requests) {
        const nextTotal = json.total ?? json.requests.length;
        setRequests(json.requests);
        setTotal(nextTotal);
        onTotalChange?.(nextTotal);
      }
    } catch {
      // 拉取失败就等下一次广播，不打断页面
    } finally {
      loading.current = false;
    }
  }, [sessionId, onTotalChange]);

  useStreamEvent((event, data) => {
    if (event !== "session.updated" && event !== "turn.updated") return;
    if (data.session_id !== sessionId) return;
    void refresh();
  });

  return (
    <>
      <div className="panel-head">
        <span>请求</span>
        <span className="count">
          {total} 条请求 · 每次 <code>before_provider_request</code> 一行
        </span>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 10.5 }}>
          序列化前 · 按顺序关联
        </span>
      </div>

      <div className="rows">
        <div className="row head request">
          <span className="num">#</span>
          <span>模型</span>
          <span>状态</span>
          <span>时间</span>
          <span className="num">输入</span>
          <span className="num">输出</span>
          <span className="num">payload</span>
          <span className="num">成本</span>
        </div>

        {requests.length === 0 ? (
          <div className="empty">
            这个会话还没有请求记录。新探针会在每次模型请求前写入一行；旧会话里探针启动之前发生的请求只能靠会话文件回填，
            而文件里没有 payload。
          </div>
        ) : null}

        {requests.map((request) => {
          const status = requestStatusMeta(request.status);
          return (
            <Link
              className="row request hover"
              key={request.request_seq}
              href={`/sessions/${encodeURIComponent(sessionId)}/requests/${request.request_seq}`}
              title={status.title}
            >
              <span className="num" style={{ color: "var(--fg-3)" }}>
                {request.request_seq}
              </span>
              <span className="col-grow">
                <span style={{ color: "var(--blue)" }}>{request.provider ?? "—"}</span>{" "}
                <span className="faint">/ {request.api ?? "—"} /</span> {request.model ?? "—"}
              </span>
              <span>
                <span className={status.className}>{status.label}</span>
              </span>
              <span className="time">{clockTime(request.created_at)}</span>
              <span className="num">{formatTokens(request.tokens_in)}</span>
              <span className="num faint">{formatTokens(request.tokens_out)}</span>
              <span className="num">
                {formatBytes(request.payload_bytes)}
                {request.payload_truncated === 1 ? <span className="badge warn">截断</span> : null}
              </span>
              <span className="num" style={{ color: request.cost === null ? undefined : "var(--amber)" }}>
                {request.cost === null ? "—" : `$ ${formatCost(request.cost)}`}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
        <div className="faint" style={{ fontSize: 11 }}>
          {total > requests.length ? `只显示最近 ${requests.length} 条，共 ${total} 条。` : null}
          每次模型请求一行；payload 保存脱敏后的结构化请求体，单条上限 512 KB，7 天后清空为{" "}
          <code>{'{"deleted":true}'}</code>，token 与成本长期保留。请求与响应没有共享 ID，按会话内顺序关联
          （<code>serial_assumed</code>）；token 与成本来自同一运行 / Turn 的助手消息。
        </div>
      </div>
    </>
  );
}
