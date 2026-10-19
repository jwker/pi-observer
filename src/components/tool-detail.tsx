"use client";

import Link from "next/link";
import { useState } from "react";

import { dateTime, formatBytes, formatDuration } from "@/lib/format.ts";
import { clipForDisplay, toolResultText, toolStatusMeta } from "@/lib/tool-view.ts";
import type { ToolCallDetail } from "@/lib/types.ts";

type Tab = "args" | "result" | "link";

interface ToolDetailViewProps {
  sessionId: string;
  sessionCwd: string;
  tool: ToolCallDetail;
  /** 同 Turn 的模型请求序号；找不到就是 null */
  requestSeq: number | null;
}

export function ToolDetailView({ sessionId, sessionCwd, tool, requestSeq }: ToolDetailViewProps) {
  const [tab, setTab] = useState<Tab>("args");
  const status = toolStatusMeta(tool.is_error, tool.duration_ms);
  const args = clipForDisplay(tool.args);
  const result = toolResultText(tool.result);
  const partial = toolResultText(tool.partial_result);

  return (
    <>
      <div className="panel">
        <div className="panel-body" style={{ display: "flex", gap: 30, flexWrap: "wrap" }}>
          <dl className="kv">
            <dt>toolCallId</dt>
            <dd>
              <code>{tool.tool_call_id}</code>
            </dd>
            <dt>父调用</dt>
            <dd>
              {tool.parent_tool_call_id === null ? (
                <span className="faint">无（顶层调用）</span>
              ) : (
                <Link href={`/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(tool.parent_tool_call_id)}`}>
                  {tool.parent_tool_call_id}
                </Link>
              )}
            </dd>
            <dt>Turn</dt>
            <dd>{tool.turn_index === null ? "—" : `Turn ${tool.turn_index}`}</dd>
            <dt>运行</dt>
            <dd>{tool.run_seq === null ? "—" : `runSeq ${tool.run_seq}`}</dd>
          </dl>
          <dl className="kv">
            <dt>开始</dt>
            <dd>{dateTime(tool.started_at)}</dd>
            <dt>结束</dt>
            <dd>{dateTime(tool.ended_at)}</dd>
            <dt>耗时</dt>
            <dd>{formatDuration(tool.duration_ms)}</dd>
            <dt>状态</dt>
            <dd>
              <span className={status.className} title={status.title}>
                {status.label}
              </span>
            </dd>
            <dt>同 Turn 请求</dt>
            <dd>
              {requestSeq === null ? (
                <span className="faint">—</span>
              ) : (
                <Link href={`/sessions/${encodeURIComponent(sessionId)}/requests/${requestSeq}`}>请求 #{requestSeq}</Link>
              )}
            </dd>
          </dl>
          <dl className="kv">
            <dt>参数大小</dt>
            <dd>{formatBytes(tool.args_bytes)}</dd>
            <dt>结果大小</dt>
            <dd>{formatBytes(tool.result_bytes)}</dd>
            <dt>部分结果</dt>
            <dd>{formatBytes(tool.partial_bytes)}</dd>
            <dt>写入方式</dt>
            <dd>
              <code>tool_call_id</code> upsert
            </dd>
          </dl>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="tabs">
          <button type="button" className={tab === "args" ? "on" : ""} onClick={() => setTab("args")}>
            参数
          </button>
          <button type="button" className={tab === "result" ? "on" : ""} onClick={() => setTab("result")}>
            结果
          </button>
          <button type="button" className={tab === "link" ? "on" : ""} onClick={() => setTab("link")}>
            关联
          </button>
        </div>

        {tab === "args" ? (
          <div className="panel-body">
            <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
              来自 <code>tool_execution_start.args</code>。完整参数在工具开始执行时就已确定，不依赖流式增量。
            </div>
            {tool.args === null ? (
              <div className="empty">这条工具调用没有记录参数。</div>
            ) : (
              <>
                <pre className="pre">{args.text}</pre>
                {args.truncated ? (
                  <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
                    参数超过 64,000 字符，只显示前段；完整内容在库里。
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {tab === "result" ? (
          <div className="panel-body">
            {tool.is_error === 1 ? (
              <div className="notice err">
                <span className="ic">✕</span>
                <div>
                  <b style={{ color: "var(--fg)" }}>工具返回错误</b>。错误不会阻断后续 Turn；结果作为{" "}
                  <code>toolResult</code> 消息进入下一轮上下文。
                </div>
              </div>
            ) : null}

            {result.kind === "empty" && partial.kind === "empty" ? (
              <div className="empty">还没有结果。工具可能仍在执行，或执行被中断。</div>
            ) : null}

            {result.kind !== "empty" ? (
              <>
                <div className="faint" style={{ fontSize: 11, margin: "12px 0 6px" }}>
                  最终结果（<code>tool_execution_end.result</code>）
                </div>
                <pre className="pre">{result.text}</pre>
              </>
            ) : null}
            {result.note ? (
              <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
                {result.note}
              </div>
            ) : null}

            {partial.kind !== "empty" ? (
              <>
                <div className="faint" style={{ fontSize: 11, margin: "14px 0 6px" }}>
                  部分结果（<code>tool_execution_update</code> 的最后一次快照）
                </div>
                <pre className="pre">{partial.text}</pre>
                {partial.note ? (
                  <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
                    {partial.note}
                  </div>
                ) : null}
              </>
            ) : null}

            <div className="notice" style={{ marginTop: 14 }}>
              <span className="ic">i</span>
              <div>
                执行过程中，<code>tool_execution_update</code> 按 <code>toolCallId</code> 覆盖同一行的{" "}
                <code>partial_result</code>；结束时写入最终结果、<code>isError</code> 与{" "}
                <code>durationMs</code>。看板不会重放这次执行。
              </div>
            </div>
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
              <dt>Turn</dt>
              <dd>{tool.turn_index === null ? "—" : `Turn ${tool.turn_index}`}</dd>
              <dt>同 Turn 的模型请求</dt>
              <dd>
                {requestSeq === null ? (
                  <span className="faint">没有找到（请求可能还没写入，或这个 Turn 没有模型请求）</span>
                ) : (
                  <Link href={`/sessions/${encodeURIComponent(sessionId)}/requests/${requestSeq}`}>请求 #{requestSeq}</Link>
                )}
              </dd>
              <dt>父调用</dt>
              <dd>{tool.parent_tool_call_id === null ? "无（顶层调用）" : tool.parent_tool_call_id}</dd>
              <dt>触发方式</dt>
              <dd>assistant 消息中的 toolCall 块</dd>
              <dt>后续</dt>
              <dd>
                工具结果作为 <code>toolResult</code> 消息进入下一轮上下文
              </dd>
            </dl>
            <div className="notice" style={{ marginTop: 14 }}>
              <span className="ic">◌</span>
              <div>
                工具与 Turn 的关联由探针在 <code>tool_execution_start</code> 时记录；升级前写入的旧调用没有
                run_seq / turn_index，界面会显示「—」。
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="notice readonly" style={{ marginTop: 14 }}>
        <span className="ic">◍</span>
        <div>工具参数与结果只读展示。界面没有「重试」「停止」「编辑参数」之类的入口，这是刻意的。</div>
      </div>
    </>
  );
}
