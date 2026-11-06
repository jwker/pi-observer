/**
 * 启动网页版服务。
 *
 * 只有一种网页版：跑的是同一个 Next.js 应用。开发（`npm run dev`）与这里
 * 的区别只是热更新与构建产物，功能完全一样。
 *
 * 流程：
 *   1. 没有构建产物就构建一次；
 *   2. 源码比构建产物新时提醒一句（不自动重建，免得每次启动都等构建）；
 *   3. 挑一个端口（默认 4173，被占用就换一个空闲的）并启动。
 *
 * 跑的是 `.next/standalone/server.js`——`next build` 用的是 standalone 产出
 * （桌面版要打包同一份产物），所以不能用 `next start`。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT, HOST, findFreePort } from "./port.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const standalone = join(repo, ".next", "standalone");

/** 源码目录：这些变了就说明构建产物旧了 */
const SOURCE_DIRS = [join(repo, "src"), join(repo, "ext")];

if (!existsSync(standalone)) {
  console.log("== 没有构建产物，先构建一次 ==");
  const result = spawnSync("npm", ["run", "build"], { stdio: "inherit", cwd: repo });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 静态资源不在 standalone 里，要单独拷进去
const staticSrc = join(repo, ".next", "static");
const staticDst = join(standalone, ".next", "static");
if (existsSync(staticSrc) && !existsSync(staticDst)) {
  cpSync(staticSrc, staticDst, { recursive: true });
}

const buildTime = buildTimestamp();
const newestSource = newestSourceTime();
if (buildTime !== null && newestSource !== null && newestSource > buildTime) {
  console.log("提示：源码比构建产物新，改过代码的话跑一次 npm run build");
}

const wanted = Number(process.env.PORT ?? DEFAULT_PORT);
const { port, switched } = await findFreePort(
  Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_PORT,
  HOST,
);
if (switched) {
  console.log(`端口 ${wanted} 被占用，改用 ${port}`);
}
process.env.PORT = String(port);
process.env.HOSTNAME = HOST;
console.log(`看板地址 http://${HOST}:${port}`);

await import(join(standalone, "server.js"));

/** 构建产物的时间：拿 .next/BUILD_ID 的修改时间 */
function buildTimestamp() {
  const marker = join(repo, ".next", "BUILD_ID");
  if (!existsSync(marker)) return null;
  try {
    return statSync(marker).mtimeMs;
  } catch {
    return null;
  }
}

/** 源码里最新的修改时间 */
function newestSourceTime() {
  let newest = null;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const mtime = statSync(full).mtimeMs;
        if (newest === null || mtime > newest) newest = mtime;
      } catch {
        // 读不到就跳过
      }
    }
  };
  for (const dir of SOURCE_DIRS) walk(dir);
  return newest;
}
