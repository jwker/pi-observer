"use client";

import { useState } from "react";

import type { EventRow, RequestIndexRow, ToolCallIndexRow, TurnRow } from "@/lib/types.ts";
import { Requests } from "./requests.tsx";
import { Tools } from "./tools.tsx";
import { Timeline } from "./timeline.tsx";

interface SessionViewsProps {
  sessionId: string;
  initialEvents: EventRow[];
  initialTurns: TurnRow[];
  initialRequests: RequestIndexRow[];
  requestTotal: number;
  initialTools: ToolCallIndexRow[];
  toolTotal: number;
}

type View = "timeline" | "requests" | "tools";

/**
 * 会话详情右侧的视图切换（PRD §11.2）。
 * 两个面板都保持挂载，只切 `display`：时间线的折叠状态与实时订阅不会因为切标签而丢。
 * M3-4 的工具视图留在这个标签条里。
 */
export function SessionViews({
  sessionId,
  initialEvents,
  initialTurns,
  initialRequests,
  requestTotal,
  initialTools,
  toolTotal,
}: SessionViewsProps) {
  const [view, setView] = useState<View>("timeline");
  const [requestCount, setRequestCount] = useState(requestTotal);
  const [toolCount, setToolCount] = useState(toolTotal);

  return (
    <div className="panel">
      <div className="tabs">
        <button type="button" className={view === "timeline" ? "on" : ""} onClick={() => setView("timeline")}>
          时间线
        </button>
        <button type="button" className={view === "requests" ? "on" : ""} onClick={() => setView("requests")}>
          请求 <span className="tab-count">{requestCount}</span>
        </button>
        <button type="button" className={view === "tools" ? "on" : ""} onClick={() => setView("tools")}>
          工具 <span className="tab-count">{toolCount}</span>
        </button>
      </div>

      <div className={view === "timeline" ? "tabpanel on" : "tabpanel"}>
        <Timeline sessionId={sessionId} initialEvents={initialEvents} initialTurns={initialTurns} embedded />
      </div>
      <div className={view === "requests" ? "tabpanel on" : "tabpanel"}>
        <Requests
          sessionId={sessionId}
          initialRequests={initialRequests}
          initialTotal={requestTotal}
          onTotalChange={setRequestCount}
        />
      </div>
      <div className={view === "tools" ? "tabpanel on" : "tabpanel"}>
        <Tools
          sessionId={sessionId}
          initialTools={initialTools}
          initialTotal={toolTotal}
          onTotalChange={setToolCount}
        />
      </div>
    </div>
  );
}
