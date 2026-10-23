"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildSessionStream, turnWindow } from "@/lib/stream.ts";
import { mergeStreamData, normalizeStreamData } from "@/lib/stream-merge.ts";
import type { StreamCategory, StreamRow, TurnWindow } from "@/lib/stream.ts";
import {
  DEFAULT_FILTERS,
  FILTER_KEY,
  parseFilters,
  stringifyFilters,
  type TimelineFilters,
} from "@/lib/filters.ts";
import type { SessionListItem, SessionStreamData } from "@/lib/types.ts";
import { useStreamEvent } from "./hooks.ts";
import { RowDetailModal, type DetailTarget } from "./row-detail-modal.tsx";
import { SessionSidebar } from "./session-sidebar.tsx";
import { SessionTimeline } from "./session-timeline.tsx";

const PAGE_SIZE = 20;

interface AppShellProps {
  initialSessions: SessionListItem[];
  initialTotal: number;
  initialSessionId: string | null;
  initialData: SessionStreamData | null;
  initialVersion: string | null;
}

interface SessionResponse {
  ok?: boolean;
  unchanged?: boolean;
  version?: string;
  /** true 表示这次只带回了最近的一段，需要和已有数据合并 */
  live?: boolean;
  data?: SessionStreamData;
  error?: string;
}

/** 单页应用：左栏项目 / 会话，右栏会话头 + 筛选 + 时间线，详情用弹窗。 */
export function AppShell({
  initialSessions,
  initialTotal,
  initialSessionId,
  initialData,
  initialVersion,
}: AppShellProps) {
  const [sessions, setSessions] = useState<SessionListItem[]>(initialSessions);
  const [total, setTotal] = useState(initialTotal);
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId);
  const [data, setData] = useState<SessionStreamData | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);
  const [filtersReady, setFiltersReady] = useState(false);
  const [openTurns, setOpenTurns] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  // 用户正在看 / 点时间线时暂停实时刷新：整页每秒换一次内容会让人点不到东西
  const [interacting, setInteracting] = useState(false);
  const paused = interacting || detail !== null;

  const selectedIdRef = useRef<string | null>(initialSessionId);
  const dataRef = useRef<SessionStreamData | null>(initialData);
  const versionRef = useRef<string | null>(initialVersion);
  const sequenceRef = useRef(0);
  const pollingRef = useRef(false);
  const autoOpenedRef = useRef<Set<string>>(new Set());

  selectedIdRef.current = selectedId;
  dataRef.current = data;

  const selected = useMemo(() => {
    const found = sessions.find((session) => session.session_id === selectedId);
    if (found !== undefined) return found;
    if (data !== null && data.session.session_id === selectedId) {
      return { ...data.session, first_user_text: null } satisfies SessionListItem;
    }
    return null;
  }, [sessions, selectedId, data]);

  const stream = useMemo(() => (data === null ? null : buildSessionStream(data)), [data]);
  const windowed: TurnWindow | null = useMemo(
    () => (stream === null ? null : turnWindow(stream, pages, PAGE_SIZE)),
    [stream, pages],
  );

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

  const loadStream = useCallback(async (
    sessionId: string,
    options: { version: string | null; showLoading: boolean },
  ) => {
    const sequence = ++sequenceRef.current;
    if (options.showLoading) setLoading(true);

    const params = new URLSearchParams({ id: sessionId });
    if (options.version !== null) params.set("v", options.version);

    try {
      const response = await fetch(`/api/session?${params.toString()}`);
      const json = (await response.json()) as SessionResponse;
      if (sequence !== sequenceRef.current || selectedIdRef.current !== sessionId) return;

      if (!response.ok || json.ok === false) {
        setError(json.error ?? "读取会话失败。");
        return;
      }
      if (json.unchanged === true) {
        setError(null);
        return;
      }
      if (json.data) {
        if (json.version !== undefined) versionRef.current = json.version;
        // 实时刷新只带最近的一段：与已有数据合并，全量首屏直接用
        const incoming = json.data;
        setData((previous) =>
          previous === null || json.live !== true
            ? incoming
            : mergeStreamData(previous, incoming),
        );
        setError(null);
        setSessions((previous) =>
          previous.map((session) =>
            session.session_id === json.data?.session.session_id
              ? { ...session, ...json.data.session, first_user_text: session.first_user_text }
              : session,
          ),
        );
      }
    } catch {
      if (sequence === sequenceRef.current) {
        setError("读取会话失败。看板服务可能已经断开。");
      }
    } finally {
      if (sequence === sequenceRef.current) setLoading(false);
    }
  }, []);

  const selectSession = useCallback(
    (sessionId: string, options?: { push?: boolean }) => {
      if (sessionId === selectedIdRef.current && dataRef.current !== null) return;
      selectedIdRef.current = sessionId;
      setSelectedId(sessionId);
      setData(null);
      setError(null);
      setPages(1);
      setDetail(null);
      setLoading(true);
      setOpenTurns(new Set());
      autoOpenedRef.current.clear();
      versionRef.current = null;

      const url = new URL(window.location.href);
      url.searchParams.set("session", sessionId);
      // 切换会话用 push：浏览器前进 / 后退能回到上一个会话
      if (options?.push === true) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);

      requestAnimationFrame(() => {
        const scroller = document.querySelector<HTMLElement>(".tl-scroll");
        if (scroller !== null) scroller.scrollTop = 0;
      });

      void loadStream(sessionId, { version: null, showLoading: true });
    },
    [loadStream],
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

  const refresh = useCallback(() => {
    if (selectedId === null) return;
    void loadStream(selectedId, { version: null, showLoading: true });
  }, [selectedId, loadStream]);

  // 打开会话时默认展开正在进行的 Turn；只自动展开一次，用户收起后不抢回来
  useEffect(() => {
    if (stream === null) return;
    const last = stream.turns[stream.turns.length - 1];
    if (last === undefined || !last.running || autoOpenedRef.current.has(last.key)) return;
    autoOpenedRef.current.add(last.key);
    setOpenTurns((previous) => new Set(previous).add(last.key));
  }, [stream]);

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

  // 任何一批写入后服务端都会广播会话更新；当前会话立即重拉，其他会话只刷列表。
  //
  // 一次模型请求会带来好几条事件（请求、响应、工具起止…），逐条重拉会让页面每秒
  // 换好几次内容，看着像在闪。这里把它们合并：800 毫秒内只重拉一次。
  const lastReloadRef = useRef(0);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const reloadNow = useCallback(() => {
    if (pausedRef.current) return;
    lastReloadRef.current = Date.now();
    void refreshSessions();
    const current = selectedIdRef.current;
    if (current === null) return;
    // 带版本号：服务端发现没变化就只回 unchanged，不重复传整套数据
    void loadStream(current, { version: versionRef.current, showLoading: false });
  }, [loadStream, refreshSessions]);

  const scheduleReload = useCallback(() => {
    if (pausedRef.current) return;
    const wait = 1500 - (Date.now() - lastReloadRef.current);
    if (wait <= 0) {
      reloadNow();
      return;
    }
    if (reloadTimerRef.current !== null) return;
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      reloadNow();
    }, wait);
  }, [reloadNow]);

  useEffect(
    () => () => {
      if (reloadTimerRef.current !== null) clearTimeout(reloadTimerRef.current);
    },
    [],
  );

  useStreamEvent((event, payload) => {
    if (event !== "session.updated") return;
    const current = selectedIdRef.current;
    const changed = typeof payload.session_id === "string" ? payload.session_id : current;
    if (current === null || changed !== current) {
      // 别的会话有动静：只刷列表
      void refreshSessions();
      return;
    }
    scheduleReload();
  });

  // 活跃会话每 2 秒轮询；版本号没变时服务端只回一个 unchanged，不做整页重渲染。
  // 用户正在操作时间线时先不刷新——整页换内容会让人点不到东西。
  useEffect(() => {
    if (selectedId === null || data?.session.state !== "active" || paused) return;
    const timer = setInterval(() => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      void loadStream(selectedId, { version: versionRef.current, showLoading: false }).finally(() => {
        pollingRef.current = false;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [selectedId, data?.session.state, loadStream, paused]);

  // 切会话时时间线停在顶部（最新在上），不做「滚到底部」
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>(".tl-scroll");
    if (scroller !== null) scroller.scrollTop = 0;
  }, [selectedId]);

  const expandAll = useCallback(() => {
    if (windowed === null) return;
    const turns = [...windowed.turns];
    const prelude = windowed.prelude;
    const shown = prelude === null ? turns : [...turns, prelude];
    const allOpen = shown.length > 0 && shown.every((turn) => openTurns.has(turn.key));

    setOpenTurns((previous) => {
      if (allOpen) return new Set();
      const next = new Set(previous);
      for (const turn of shown) next.add(turn.key);
      return next;
    });
  }, [windowed, openTurns]);

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
                ? "还没有任何会话数据：会话文件目录里没有读到 .jsonl，探针也还没收到过事件。"
                : "从左侧选择一个会话。"}
            </div>
          </main>
        ) : (
          <SessionTimeline
        onInteractChange={setInteracting}
            session={selected}
            data={data}
            stream={stream}
            turnWindow={windowed}
            filters={filters}
            loading={loading}
            error={error}
            openTurns={openTurns}
            onToggleCategory={toggleCategory}
            onToggleThink={toggleThink}
            onToggleBranch={toggleBranch}
            onToggleTurn={toggleTurn}
            onExpandAll={expandAll}
            onLoadEarlier={() => setPages((previous) => previous + 1)}
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

