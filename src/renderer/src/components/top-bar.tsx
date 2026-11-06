"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";

const THEME_KEY = "pi-observer-theme";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** 顶栏：品牌、主题切换。没有探针状态，也��有设置页——项目不再有服务端的写操作。 */
export function TopBar() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function apply(next: Theme): void {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 隐私模式存不了，只影响下次打开
    }
    setTheme(next);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (event.key.toLowerCase() === "d") {
        apply(currentTheme() === "light" ? "dark" : "light");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="dot">●</span>pi-observer <span className="sub">会话文件</span>
        </div>
        <div className="spacer" />
        <button
          className="btn ghost"
          onClick={() => apply(theme === "light" ? "dark" : "light")}
          title={theme === "light" ? "切换到暗色（D）" : "切换到亮色（D）"}
          aria-pressed={theme === "light"}
        >
          <span>{theme === "light" ? "☀" : "☾"}</span>
          <span>{theme === "light" ? "亮色" : "暗色"}</span>
        </button>
      </div>
    </div>
  );
}
