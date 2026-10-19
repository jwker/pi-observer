"use client";

import Link from "next/link";
import { useState } from "react";

import { dateTime, formatBytes, formatCost, formatTokens } from "@/lib/format.ts";
import { cacheUsage, payloadSections, requestStatusMeta } from "@/lib/request-view.ts";
import type { RequestDetail } from "@/lib/types.ts";

type Tab = "payload" | "headers" | "usage" | "link";

interface RequestDetailViewProps {
  sessionId: string;
  sessionCwd: string;
  request: RequestDetail;
}

function usageValue(usage: unknown, key: string): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

/** usage.cost.total；没有就返回 null */
function usageCost(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const cost = (usage as Record<string, unknown>).cost;
  if (typeof cost !== "object" || cost === null) return null;
  const total = (cost as Record<string, unknown>).total;
  return typeof total === "number" ? total : null;
}

function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

export function RequestDetailView({ sessionId, sessionCwd, request }: RequestDetailViewProps) {
  const [tab, setTab] = useState<Tab>("payload");
  const [copied, setCopied] = useState(false);
  const status = requestStatusMeta(request.status);
  const sections = payloadSections(request.payload);
  const cache = cacheUsage(request.turn_usage);
  const totalMs = durationMs(request.turn_started_at, request.turn_ended_at);
  const input = request.tokens_in ?? usageValue(request.turn_usage, "input");
  const output = request.tokens_out ?? usageValue(request.turn_usage, "output");
  const cost = request.cost ?? usageCost(request.turn_usage);

  const copyPayload = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(request.payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 浏览器不给剪贴板权限就保持原样，不弹假成功
    }
  };

  return (
    <>
      <div className="panel">
        <div className="panel-body" style={{ display: "flex", gap: 30, flexWrap: "wrap" }}>
          <dl className="kv">
            <dt>请求序号</dt>
            <dd>
              #{request.request_seq} · <code>request_seq {request.request_seq}</code>
            </dd>
            <dt>发出时间</dt>
            <dd>{dateTime(request.created_at)}</dd>
            <dt>状态</dt>
            <dd>
              <span className={status.className} title={status.title}>
                {status.label}
              </span>
            </dd>
            <dt>关联</dt>
            <dd>
              {request.run_seq === null ? "—" : `runSeq ${request.run_seq}`} ·{" "}
              {request.turn_index === null ? "—" : `Turn ${request.turn_index}`}
            </dd>
          </dl>
          <dl className="kv">
            <dt>payload 大小</dt>
            <dd>
              {formatBytes(request.payload_bytes)} <span className="faint">（结构化，未序列化）</span>
            </dd>
            <dt>单条上限</dt>
            <dd>
              {request.payload_truncated === 1 ? (
                <span className="badge warn">已截断（512 KB）</span>
              ) : (
                <span className="badge ok">未截断</span>
              )}
            </dd>
            <dt>响应头</dt>
            <dd>{request.response_headers === null ? "未收到" : `${formatBytes(request.response_headers_bytes)}`}</dd>
            <dt>来源</dt>
            <dd>
              <code>before_provider_request</code> / <code>after_provider_response</code>
            </dd>
          </dl>
          <div className="metrics" style={{ gap: "0 24px" }}>
            <div className="metric">
              <span className="label">输入</span>
              <span className="v up">↑ {formatTokens(input)}</span>
            </div>
            <div className="metric">
              <span className="label">输出</span>
              <span className="v down">↓ {formatTokens(output)}</span>
            </div>
            <div className="metric">
              <span className="label">缓存读取</span>
              <span className="v" style={{ color: "var(--cyan)" }}>
                R {formatTokens(cache.read)}
              </span>
            </div>
            <div className="metric">
              <span className="label">缓存写入</span>
              <span className="v" style={{ color: "var(--cyan)" }}>
                W {formatTokens(cache.write)}
              </span>
            </div>
            <div className="metric">
              <span className="label">成本</span>
              <span className="v cost">$ {formatCost(cost)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="tabs">
          <button type="button" className={tab === "payload" ? "on" : ""} onClick={() => setTab("payload")}>
            Payload
          </button>
          <button type="button" className={tab === "headers" ? "on" : ""} onClick={() => setTab("headers")}>
            响应头
          </button>
          <button type="button" className={tab === "usage" ? "on" : ""} onClick={() => setTab("usage")}>
            Token 与成本
          </button>
          <button type="button" className={tab === "link" ? "on" : ""} onClick={() => setTab("link")}>
            关联
          </button>
        </div>

        {tab === "payload" ? (
          <div>
            <div className="panel-body" style={{ paddingBottom: 4 }}>
              <div className="notice warn">
                <span className="ic">▲</span>
                <div>
                  payload 含系统提示、完整对话历史与工具定义。已按键名黑名单剔除凭据；这里是 Pi 交给 provider 的
                  <b style={{ color: "var(--fg)" }}> 结构化请求体，不是 wire 级字节</b>，序列化后的实际长度可能略有不同。
                  {request.payload_truncated === 1 ? " 这条超过 512 KB，库里只保留了标记与前 4 KB 预览。" : null}
                </div>
              </div>
            </div>

            {sections.length === 0 ? (
              <div className="empty">这条请求没有 payload（可能是升级前写入的旧记录，或被清理过）。</div>
            ) : (
              sections.map((section) => (
                <details className="fold" key={section.key}>
                  <summary>
                    <span>{section.label}</span>
                    <span className="faint">
                      {section.count === null ? "" : `${section.count} · `}
                      {formatBytes(section.bytes)}
                    </span>
                    <span className="spacer" />
                  </summary>
                  <div className="fold-body">
                    <pre className="pre">{section.preview}</pre>
                    {section.truncated ? (
                      <div className="faint" style={{ fontSize: 11 }}>
                        只显示前 12,000 个字符；完整内容在库里（上限 512 KB）。
                      </div>
                    ) : null}
                  </div>
                </details>
              ))
            )}

            <div className="panel-body" style={{ borderTop: "1px solid var(--border)", display: "flex", gap: 10 }}>
              <button className="btn" type="button" onClick={() => void copyPayload()} disabled={request.payload === null}>
                {copied ? "已复制" : "复制脱敏 payload"}
              </button>
              <span className="faint" style={{ fontSize: 11 }}>
                复制的是当前展示的脱敏版本；不含被剔除的凭据。
              </span>
            </div>
          </div>
        ) : null}

        {tab === "headers" ? (
          <div>
            {request.response_headers === null ? (
              <div className="empty">
                还没有收到响应头。<code>after_provider_response</code> 在响应流被消费之前触发；请求中断或还没返回时这里是空的。
              </div>
            ) : (
              <>
                <div className="rows">
                  <div className="row head" style={{ gridTemplateColumns: "220px 1fr" }}>
                    <span>header</span>
                    <span>value</span>
                  </div>
                  {Object.entries(request.response_headers as Record<string, unknown>).map(([key, value]) => (
                    <div className="row" style={{ gridTemplateColumns: "220px 1fr" }} key={key}>
                      <span className="muted">{key}</span>
                      <span style={{ wordBreak: "break-all" }}>
                        {value === "[redacted]" ? <span className="faint">（已脱敏）</span> : String(value)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
                  <div className="faint" style={{ fontSize: 11 }}>
                    响应头来自 <code>after_provider_response</code>；只有状态码与 header，没有 body。响应正文由流式事件重建。
                  </div>
                </div>
              </>
            )}
          </div>
        ) : null}

        {tab === "usage" ? (
          <div className="panel-body">
            {request.turn_usage === null ? (
              <div className="notice">
                <span className="ic">◌</span>
                <div>
                  这条请求还没有关联到 Turn 的 usage。
                  {request.run_seq === null || request.turn_index === null
                    ? " 记录里没有 run_seq / turn_index（可能是 M3-1 之前写入的旧记录），无法按运行与 Turn 关联。"
                    : " 这一轮可能还没结束，助手消息落盘后才会有 usage。"}
                </div>
              </div>
            ) : null}
            <div className="metrics" style={{ gap: "0 40px", marginTop: request.turn_usage === null ? 14 : 0 }}>
              <div className="metric">
                <span className="label">输入</span>
                <span className="v up">{formatTokens(input)}</span>
              </div>
              <div className="metric">
                <span className="label">输出</span>
                <span className="v down">{formatTokens(output)}</span>
              </div>
              <div className="metric">
                <span className="label">缓存读取</span>
                <span className="v" style={{ color: "var(--cyan)" }}>
                  {formatTokens(cache.read)}
                </span>
              </div>
              <div className="metric">
                <span className="label">缓存写入</span>
                <span className="v" style={{ color: "var(--cyan)" }}>
                  {formatTokens(cache.write)}
                </span>
              </div>
              <div className="metric">
                <span className="label">成本</span>
                <span className="v cost">$ {formatCost(cost)}</span>
              </div>
            </div>
            <div className="notice" style={{ marginTop: 14 }}>
              <span className="ic">i</span>
              <div>
                token 与成本来自助手消息自带的 <code>usage</code>（含 <code>cost</code> 明细），不依赖额外钩子。
                payload 7 天后会被清空，但 token 与成本字段长期保留。
              </div>
            </div>
            {request.turn_usage === null ? null : (
              <pre className="pre" style={{ marginTop: 12 }}>{JSON.stringify(request.turn_usage, null, 2)}</pre>
            )}
          </div>
        ) : null}

        {tab === "link" ? (
          <div className="panel-body">
            <dl className="kv" style={{ gap: "8px 18px" }}>
              <dt>会话</dt>
              <dd>
                <Link href={`/sessions/${encodeURIComponent(sessionId)}`}>{sessionId}</Link>
                {sessionCwd ? <span className="faint"> · {sessionCwd}</span> : null}
              </dd>
              <dt>运行</dt>
              <dd>{request.run_seq === null ? "—" : `runSeq ${request.run_seq}`}</dd>
              <dt>Turn</dt>
              <dd>{request.turn_index === null ? "—" : `Turn ${request.turn_index}`}</dd>
              <dt>Turn 时间</dt>
              <dd>
                {dateTime(request.turn_started_at)} → {dateTime(request.turn_ended_at)}
                {totalMs === null ? null : <span className="faint"> · {totalMs} ms</span>}
              </dd>
              <dt>结束原因</dt>
              <dd>{request.turn_stop_reason ?? "—"}</dd>
              <dt>配对方式</dt>
              <dd>
                <span className="badge info">{request.correlation}</span> 请求与响应没有共享 ID，按会话内顺序配对
              </dd>
            </dl>
            <div className="notice" style={{ marginTop: 14 }}>
              <span className="ic">◌</span>
              <div>
                为什么不能强关联：<code>before_provider_request</code> 与 <code>after_provider_response</code> 都不提供请求 ID。
                单会话内请求串行，因此顺序可靠；出现并发时界面会降级为「可能错配」。
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="notice readonly" style={{ marginTop: 14 }}>
        <span className="ic">◍</span>
        <div>只读：不能重发请求、不能修改参数、不能复制出凭据。可复制的只有脱敏后的 payload。</div>
      </div>
    </>
  );
}
