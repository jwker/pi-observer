/**
 * electron-vite 构建配置：主进程、preload、渲染进程三份分开构建。
 *
 * 三份的差别：
 *   - main / preload 跑在 Node 里，可以 import node:* 模块，产物是 CJS/mjs；
 *   - renderer 跑在浏览器里，只能是纯前端代码，不能碰 node:*；
 *   - 三份共享 `src/shared/types.ts`（纯类型，没有运行时依赖）。
 */
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // 主进程的依赖不打包进产物，安装时保持外部引用
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve("src/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        // sandbox 模式下的 preload 只能是 CommonJS：Electron 不支持 ESM preload
        // 配合 sandbox: true。扩展名用 .cjs，避免被 package.json 的 type: module 当成 ESM。
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    server: {
      // 开发服务器只绑回环。固定 127.0.0.1 而不是 localhost：
      // localhost 可能解析到 ::1，而端口探测走的是 IPv4，两者不一致时
      // 日志里显示的端口和实际监听的端口会对不上。
      host: "127.0.0.1",
      // 端口交给操作系统分配：5173 这类默认端口很容易碰上别的 Vite 项目。
      // 实际地址由 electron-vite 通过 ELECTRON_RENDERER_URL 告诉主进程，
      // 所以没有地方需要预先知道端口号。
      port: 0,
    },
    build: {
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
  },
});
