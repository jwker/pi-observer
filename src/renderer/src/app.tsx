/**
 * 渲染进程的启动入口：先把首屏要的数据取回来，再挂载界面。
 *
 * 原来这一步在服务端组件里做（页面发出去时 HTML 里已经有内容）。
 * 现在没有服务端了，所以改成挂载前走一次 IPC：会话列表 + 选中的那个会话。
 */
import { useEffect, useState } from "react";

import { AppShell } from "./components/app-shell.tsx";
import { TopBar } from "./components/top-bar.tsx";
import type { SessionListItem, SessionWindow } from "@shared/types.ts";

/** 首屏取多少个 Turn */
const FIRST_PAGE = 20;

interface Boot {
  sessions: SessionListItem[];
  selectedId: string | null;
  data: SessionWindow | null;
}

export function App(): React.JSX.Element {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const listed = await window.piObserver.listSessions(500);
        if (cancelled) return;
        if (!listed.ok) {
          setError(listed.error);
          return;
        }
        const sessions = listed.data;
        const selectedId = sessions[0]?.session_id ?? null;
        const loaded =
          selectedId === null ? null : await window.piObserver.loadSession(selectedId, { turns: FIRST_PAGE });
        if (cancelled) return;

        if (loaded !== null && !loaded.ok) {
          setError(loaded.error);
          return;
        }
        setBoot({
          sessions,
          selectedId,
          data: loaded === null ? null : loaded.data,
        });
      } catch (cause) {
        if (!cancelled) setError(`读取会话失败：${(cause as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) {
    return (
      <div className="app">
        <TopBar />
        <div className="empty" style={{ padding: "80px 12px" }}>
          {error}
        </div>
      </div>
    );
  }

  if (boot === null) {
    return (
      <div className="app">
        <TopBar />
        <div className="empty" style={{ padding: "80px 12px" }}>
          正在读取会话文件…
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar />
      <AppShell
        initialSessions={boot.sessions}
        initialTotal={boot.sessions.length}
        initialSessionId={boot.selectedId}
        initialData={boot.data}
      />
    </div>
  );
}
