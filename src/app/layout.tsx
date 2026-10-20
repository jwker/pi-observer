import type { Metadata } from "next";

import { StatusBar } from "@/components/status-bar.tsx";
import { TopBar } from "@/components/top-bar.tsx";

import "./globals.css";

export const metadata: Metadata = {
  title: "pi-observer",
  description: "Pi 运行时数据的只读本地看板（单机、仅 127.0.0.1）",
};

/** 首屏绘制前应用主题，避免暗色闪一下；存不了 localStorage 时保持默认暗色。 */
const THEME_BOOT = `(function () {
  try {
    var t = localStorage.getItem("pi-observer-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) {}
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body data-page="shell">
        <div className="app">
          <TopBar />
          {children}
          <StatusBar />
        </div>
      </body>
    </html>
  );
}
