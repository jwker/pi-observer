"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ProbePill } from "./probe-pill.tsx";

/** 顶栏：品牌、导航、探针状态。M1 只有会话列表一个入口，其余页面随 M2/M4 补 */
export function TopBar() {
  const pathname = usePathname();
  const onSessions = pathname === "/";
  const onSession = pathname.startsWith("/sessions/");

  return (
    <div className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="dot">●</span>pi-observer <span className="sub">只读</span>
        </div>
        <nav className="nav">
          <Link className={onSessions ? "active" : undefined} href="/">
            会话列表
          </Link>
          {onSession ? (
            <Link className="active" href={pathname}>
              会话详情
            </Link>
          ) : null}
        </nav>
        <div className="spacer" />
        <ProbePill />
      </div>
    </div>
  );
}
