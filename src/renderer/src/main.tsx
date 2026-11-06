import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import "./styles.css";

// 首屏绘制前应用主题，避免暗色闪一下；存不了 localStorage 时保持默认暗色。
try {
  const saved = localStorage.getItem("pi-observer-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {
  // 隐私模式下读不到，用默认值
}

const container = document.getElementById("root");
if (container === null) throw new Error("找不到 #root 容器");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
