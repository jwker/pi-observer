import type { Metadata } from "next";

import { StatusBar } from "@/components/status-bar.tsx";
import { TopBar } from "@/components/top-bar.tsx";

import "./globals.css";

export const metadata: Metadata = {
  title: "pi-observer",
  description: "Pi 运行时数据的只读本地看板（单机、仅 127.0.0.1）",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <TopBar />
        {children}
        <StatusBar />
      </body>
    </html>
  );
}
