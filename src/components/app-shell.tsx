"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_FILTERS,
  FILTER_KEY,
  parseFilters,
  stringifyFilters,
  type TimelineFilters,
} from "@/lib/filters.ts";
import type { StreamCategory, StreamRow } from "@/lib/stream.ts";
import type { SessionListItem, SessionWindow } from "@/lib/types.ts";
import { RowDetailModal, type DetailTarget } from "./row-detail-modal.tsx";
import { SessionSidebar } from "./session-sidebar.tsx";
import { SessionTimeline } from "./session-timeline.tsx";

const PAGE_SIZE = 20;

interface AppShellProps {
  initialSessions: SessionListItem[];
  initialTotal: number;
  initialSessionId: string | null;
  initialData: SessionWindow | null;
}

/**
 * 单页应用：左栏项目 / 会话，右栏会话头 + 筛选 + 时间线。
 *
 * 没有实时刷新：数据在服务端渲染时读一次，之后由页面上的「刷新」按钮触发。
 * 「加载更早」会再问服务端要更早的一段。
 */
export function AppShell({
  initialSessions,
  initialTotal,
  initialSessionId,
  initialData,
}: AppShellProps) {
  const [sessions, setSessions] = useState<SessionListItem[]>(initialSessions);
  const [total, setTotal] = useState(initialTotal);
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId);
  const [window_, setWindow] = useState<SessionWindow | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);
  const [filtersReady, setFiltersReady] = useState(false);
  const [openTurns, setOpenTurns] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  const selectedIdRef = useRef<string | null>(initialSessionId);
  const sequenceRef = useRef(0);

  selectedIdRef.current = selectedId;

  const selected = useMemo(() => {
    const found = sessions.find((session) => session.session_id === selectedId);
    if (found !== undefined) return found;
    if (window_ !== null && window_.session.session_id === selectedId) return window_.session;
    return null;
  }, [sessions, selectedId, window_]);

  const refreshSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions?limit=1000");
      const json = (await response.json()) as {
        sessions?: SessionListItem[];
        total?: number;
      };
      if (json.sessions) setSessions(json.sessions);
      if (typeof json.total === "number") setTotal(json.total);
    } catch {
      // 列表刷新失败保持旧数据；会话本身仍可用
    }
  }, []);

  /**
   * 取一段会话数据。
   *
   * `before` 不为空时是要更早的一段，结果接到已有数据前面（更早的 Turn 在下面）。
   */
  const loadWindow = useCallback(
    async (sessionId: string, options: { before: number | null; append: boolean; showLoading: boolean }) => {
      const sequence = ++sequenceRef.current;
      if (options.showLoading) setLoading(true);
      const params = new URLSearchParams({ id: sessionId, turns: String(PAGE_SIZE) });
      if (options.before !== null) params.set("before", String(options.before));

      try {
        const response = await fetch(`/api/session?${params.toString()}`);
        const json = (await response.json()) as { ok?: boolean; data?: SessionWindow; error?: string };
        if (sequence !== sequenceRef.current || selectedIdRef.current !== sessionId) return;
        if (!response.ok || json.ok === false) {
          setError(json.error ?? "读取会话失败。");
          return;
        }
        if (json.data) {
          setWindow((previous) => {
            if (!options.append || previous === null) return json.data!;
            // 更早的一段接在前面：Turn 是正序，早的在前
            const merged = new Map<string, SessionWindow["turns"][number]>();
            for (const turn of [...json.data!.turns, ...previous.turns]) merged.set(turn.key, turn);
            return {
              ...previous,
              turns: [...merged.values()],
              prelude: json.data!.prelude ?? previous.prelude,
              hasEarlier: json.data!.hasEarlier,
            };
          });
          setError(null);
        }
      } catch {
        if (sequence === sequenceRef.current) setError("读取会话失败。看板服务可能已经断开。");
      } finally {
        if (sequence === sequenceRef.current) setLoading(false);
      }
    },
    [],
  );

  const selectSession = useCallback(
    (sessionId: string, options?: { push?: boolean }) => {
      if (sessionId === selectedIdRef.current) return;
      selectedIdRef.current = sessionId;
      setSelectedId(sessionId);
      setWindow(null);
      setError(null);
      setDetail(null);
      setLoading(true);
      setOpenTurns(new Set());

      const url = new URL(window.location.href);
      url.searchParams.set("session", sessionId);
      // 切换会话用 push：浏览器前进 / 后退能回到上一个会话
      if (options?.push === true) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);

      requestAnimationFrame(() => {
        const scroller = document.querySelector<HTMLElement>(".tl-scroll");
        if (scroller !== null) scroller.scrollTop = 0;
      });

      void loadWindow(sessionId, { before: null, append: false, showLoading: true });
    },
    [loadWindow],
  );

  // 首屏没带 ?session= 时补上，让地址栏始终等于当前会话
  useEffect(() => {
    if (initialSessionId === null) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("session") === initialSessionId) return;
    url.searchParams.set("session", initialSessionId);
    window.history.replaceState(null, "", url);
  }, [initialSessionId]);

  // 浏览器前进 / 后退：按 URL 里的会话切换
  useEffect(() => {
    function onPopState(): void {
      const id = new URLSearchParams(window.location.search).get("session");
      if (id === null || id === selectedIdRef.current) return;
      selectSession(id);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [selectSession]);

  /** 刷新：重读当前会话文件，同时刷新列表 */
  const refresh = useCallback(() => {
    void refreshSessions();
    if (selectedIdRef.current === null) return;
    void loadWindow(selectedIdRef.current, { before: null, append: false, showLoading: true });
  }, [loadWindow, refreshSessions]);

  /** 加载更早的一段 Turn */
  const loadEarlier = useCallback(() => {
    if (window_ === null || selectedIdRef.current === null) return;
    const oldest = window_.turns[0];
    const before = oldest?.index ?? 1;
    setLoadingEarlier(true);
    void loadWindow(selectedIdRef.current, { before: before - 1, append: true, showLoading: false }).finally(() =>
      setLoadingEarlier(false),
    );
  }, [window_, loadWindow]);

  // 筛选存 localStorage；首屏先按默认全开渲染，挂载后再套用保存值
  useEffect(() => {
    try {
      setFilters(parseFilters(localStorage.getItem(FILTER_KEY)));
    } catch {
      // 读不到就用默认值
    } finally {
      setFiltersReady(true);
    }
  }, []);

  useEffect(() => {
    if (!filtersReady) return;
    try {
      localStorage.setItem(FILTER_KEY, stringifyFilters(filters));
    } catch {
      // 存不了只影响下次打开
    }
  }, [filters, filtersReady]);

  const expandAll = useCallback(() => {
    if (window_ === null) return;
    const shown = window_.prelude === null ? window_.turns : [...window_.turns, window_.prelude];
    const allOpen = shown.length > 0 && shown.every((turn) => openTurns.has(turn.key));

    setOpenTurns((previous) => {
      if (allOpen) return new Set();
      const next = new Set(previous);
      for (const turn of shown) next.add(turn.key);
      return next;
    });
  }, [window_, openTurns]);

  const toggleTurn = useCallback((key: string) => {
    if (key === "") return;
    setOpenTurns((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((category: StreamCategory) => {
    setFilters((previous) => ({ ...previous, [category]: !previous[category] }));
  }, []);

  const toggleThink = useCallback(() => {
    setFilters((previous) => ({ ...previous, think: !previous.think }));
  }, []);

  const toggleBranch = useCallback(() => {
    setFilters((previous) => ({ ...previous, branch: !previous.branch }));
  }, []);

  const closeDetail = useCallback(() => setDetail(null), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (event.key === "/") {
        const input = document.querySelector<HTMLInputElement>("[data-sb-search]");
        if (input !== null) {
          input.focus();
          event.preventDefault();
        }
        return;
      }
      if (detail !== null) return;
      if (event.key.toLowerCase() === "t") toggleThink();
      if (event.key.toLowerCase() === "b") toggleBranch();
      if (event.key.toLowerCase() === "e") expandAll();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [detail, toggleThink, toggleBranch, expandAll]);

  return (
    <>
      <div className="app-body">
        <SessionSidebar
          sessions={sessions}
          total={total}
          selectedId={selectedId}
          onSelect={(sessionId) => selectSession(sessionId, { push: true })}
        />

        {selected === null ? (
          <main className="main">
            <div className="empty" style={{ padding: "80px 12px" }}>
              {sessions.length === 0
                ? "还没有任何会话文件：在会话目录里放几个 .jsonl 就能看到。"
                : "从左侧选择一个会话。"}
            </div>
          </main>
        ) : (
          <SessionTimeline
            session={selected}
            data={window_}
            filters={filters}
            loading={loading}
            loadingEarlier={loadingEarlier}
            error={error}
            openTurns={openTurns}
            onToggleCategory={toggleCategory}
            onToggleThink={toggleThink}
            onToggleBranch={toggleBranch}
            onToggleTurn={toggleTurn}
            onExpandAll={expandAll}
            onLoadEarlier={loadEarlier}
            onRefresh={refresh}
            onDetail={(row: StreamRow) => {
              if (selectedId !== null) setDetail({ sessionId: selectedId, row });
            }}
          />
        )}
      </div>

      {detail !== null ? <RowDetailModal target={detail} onClose={closeDetail} /> : null}
    </>
  );
}
