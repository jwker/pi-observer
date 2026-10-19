"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";

import { clockTime, formatDuration } from "@/lib/format.ts";
import {
  filterToolCalls,
  toolArgSummary,
  toolNameOptions,
  toolStatusMeta,
  toolTurnOptions,
  type ToolFilter,
} from "@/lib/tool-view.ts";
import type { ToolCallIndexRow } from "@/lib/types.ts";
import { useStreamEvent } from "./hooks.ts";

interface ToolsProps {
  sessionId: string;
  initialTools: ToolCallIndexRow[];
  initialTotal: number;
  onTotalChange?: (total: number) => void;
}

/**
 * 工具列表（PRD §11.2 视图三 / M3-4）。
 * 列表只带参数预览和字节数，完整参数 / 结果点进详情页再取。
 * 名称、Turn、是否出错三种筛选用纯函数 `filterToolCalls`，单测覆盖。
 */
export function Tools({ sessionId, initialTools, initialTotal, onTotalChange }: ToolsProps) {
  const [tools, setTools] = useState<ToolCallIndexRow[]>(initialTools);
  const [total, setTotal] = useState(initialTotal);
  const [filter, setFilter] = useState<ToolFilter>({ toolName: "all", turn: "all", errorsOnly: false });
  const loading = useRef(false);

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tools?limit=500`);
      if (!response.ok) return;
      const json = (await response.json()) as { tools?: ToolCallIndexRow[]; total?: number };
      if (json.tools) {
        const nextTotal = json.total ?? json.tools.length;
        setTools(json.tools);
        setTotal(nextTotal);
        onTotalChange?.(nextTotal);
      }
    } catch {
      // 拉取失败就等下一次广播
    } finally {
      loading.current = false;
    }
  }, [sessionId, onTotalChange]);

  useStreamEvent((event, data) => {
    if (event !== "session.updated" && event !== "turn.updated") return;
    if (data.session_id !== sessionId) return;
    void refresh();
  });

  const names = useMemo(() => toolNameOptions(tools), [tools]);
  const turns = useMemo(() => toolTurnOptions(tools), [tools]);
  const visible = useMemo(() => filterToolCalls(tools, filter), [tools, filter]);

  return (
    <>
      <div className="panel-head">
        <span>工具</span>
        <span className="count">
          {visible.length} / {total} 次工具调用
        </span>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 10.5 }}>
          按 toolCallId 幂等写入
        </span>
      </div>

      <div className="panel-body toolbar" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="seg">
          <button type="button" className={filter.toolName === "all" ? "on" : ""} onClick={() => setFilter((f) => ({ ...f, toolName: "all" }))}>
            全部
          </button>
          {names.map((name) => (
            <button
              type="button"
              key={name}
              className={filter.toolName === name ? "on" : ""}
              onClick={() => setFilter((f) => ({ ...f, toolName: name }))}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="seg">
          <button
            type="button"
            className={filter.errorsOnly ? "" : "on"}
            onClick={() => setFilter((f) => ({ ...f, errorsOnly: false }))}
          >
            全部结果
          </button>
          <button
            type="button"
            className={filter.errorsOnly ? "on" : ""}
            onClick={() => setFilter((f) => ({ ...f, errorsOnly: true }))}
          >
            仅出错
          </button>
        </div>
        <div className="seg">
          <button type="button" className={filter.turn === "all" ? "on" : ""} onClick={() => setFilter((f) => ({ ...f, turn: "all" }))}>
            全部 Turn
          </button>
          {turns.map((turn) => (
            <button
              type="button"
              key={turn}
              className={filter.turn === String(turn) ? "on" : ""}
              onClick={() => setFilter((f) => ({ ...f, turn: String(turn) }))}
            >
              {turn}
            </button>
          ))}
        </div>
      </div>

      <div className="rows">
        <div className="row head toolrow">
          <span>工具 / 参数</span>
          <span>Turn</span>
          <span className="num">耗时</span>
          <span>结果</span>
          <span className="num">开始</span>
          <span className="num">操作</span>
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            {tools.length === 0
              ? "这个会话还没有工具调用记录。新探针会在 tool_execution_start / _end 时写入；旧会话的这部分只能靠实时事件，文件里没有完整的执行过程。"
              : "没有匹配的工具调用。"}
          </div>
        ) : null}

        {visible.map((tool) => {
          const status = toolStatusMeta(tool.is_error, tool.duration_ms);
          return (
            <Link
              className="row toolrow hover"
              key={tool.tool_call_id}
              href={`/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(tool.tool_call_id)}`}
              title={status.title}
            >
              <span className="col-grow">
                <span style={{ color: "var(--pink)" }}>{tool.tool_name || "—"}</span>{" "}
                <span className="faint">{toolArgSummary(tool.args_preview)}</span>
              </span>
              <span className="faint">{tool.turn_index ?? "—"}</span>
              <span className="num">{formatDuration(tool.duration_ms)}</span>
              <span>
                <span className={status.className}>{status.label}</span>
              </span>
              <span className="num time">{clockTime(tool.started_at)}</span>
              <span className="num">
                <span className="btn sm">详情</span>
              </span>
            </Link>
          );
        })}
      </div>

      <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
        <div className="faint" style={{ fontSize: 11 }}>
          {total > tools.length ? `只显示最早 ${tools.length} 次，共 ${total} 次。` : null}
          参数与结果来自 <code>tool_execution_start</code> / <code>_update</code> / <code>_end</code>；执行中的部分结果按{" "}
          <code>toolCallId</code> 覆盖 <code>partial_result</code>，结束时写入最终结果、耗时与 isError。看板不会重放工具。
        </div>
      </div>
    </>
  );
}
