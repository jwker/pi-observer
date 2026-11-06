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
    build: {
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
  },
});
