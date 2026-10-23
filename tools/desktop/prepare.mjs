/**
 * 组装桌面版的资源目录。
 *
 * 做什么：
 *   1. 跑 `next build`（standalone 产出）；
 *   2. 把服务产物裁剪好放到 `desktop/resources/server`；
 *   3. 把探针源码放到 `desktop/resources/probe`（Pi 加载的是这里的代码）；
 *   4. 写一份清单，说明资源目录里有什么、占多大。
 *
 * 裁剪的依据：
 *   - `node_modules/@img` 是 Next 的图片优化二进制（18 MB），这个看板没有用
 *     `next/image`，删掉不影响任何页面；
 *   - `docs/` `test/` `tools/` `desktop/` 是仓库里的开发文件，服务运行时用不到。
 *     `desktop/` 尤其要删：standalone 产物会把整个工程目录拷进去，
 *     而 desktop/ 里又有一份上一轮的产物，越拷越大（实测 399 MB）；
 *   - `ext/` 与 `src/` 要留着：探针要 import `../src/lib/protocol.ts` 与
 *     `payload-files.ts`，相对路径不能断。
 *
 * 用法：node tools/desktop/prepare.mjs [--skip-build]
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const RESOURCES = join(REPO, "desktop", "resources");

/** 删掉这些目录：运行时用不到 */
const DROP_DIRS = ["docs", "test", "tools", "desktop"];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd: REPO });
  if (result.status !== 0) {
    process.stderr.write(result.stderr.toString());
    throw new Error(`${command} ${args.join(" ")} 失败（退出码 ${result.status}）`);
  }
  process.stdout.write(result.stdout.toString());
}

/** 目录占多少字节（递归）。注意：递归时不能提前换算成 MB，否则单位会混 */
function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(full) : statSync(full).size;
  }
  return total;
}

const toMB = (bytes) => Number((bytes / (1024 * 1024)).toFixed(1));

if (!process.argv.includes("--skip-build")) {
  console.log("== 构建 ==");
  // 先删掉上一轮的打包产物：Next 的 standalone 产物会把整个工程目录拷进去，
  // 而 desktop/out/ 里装着上一轮的 .app（几百 MB），不删的话每构建一次就大一轮。
  rmSync(join(REPO, "desktop", "out"), { recursive: true, force: true });
  run("npm", ["run", "build"]);
}

const standalone = join(REPO, ".next", "standalone");
if (!existsSync(standalone)) {
  throw new Error("没有 .next/standalone，先跑 npm run build");
}

console.log("== 组装资源 ==");
rmSync(RESOURCES, { recursive: true, force: true });
mkdirSync(RESOURCES, { recursive: true });

// 1) 服务产物
const serverDir = join(RESOURCES, "server");
cpSync(standalone, serverDir, { recursive: true });
// 静态资源不在 standalone 里，要单独拷进去
cpSync(join(REPO, ".next", "static"), join(serverDir, ".next", "static"), { recursive: true });

// 2) 裁剪
const dropped = [];
for (const name of DROP_DIRS) {
  const target = join(serverDir, name);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    dropped.push(name);
  }
}
// 图片优化二进制：这个看板不用 next/image
const imgDir = join(serverDir, "node_modules", "@img");
if (existsSync(imgDir)) {
  rmSync(imgDir, { recursive: true, force: true });
  dropped.push("node_modules/@img");
}
// TypeScript 的增量编译缓存，服务运行时不需要
rmSync(join(serverDir, "tsconfig.tsbuildinfo"), { force: true });

// 3) 探针源码：Pi 加载的是这里的代码，相对导入要保持结构
const probeDir = join(RESOURCES, "probe");
mkdirSync(probeDir, { recursive: true });
cpSync(join(REPO, "ext"), join(probeDir, "ext"), { recursive: true });
cpSync(join(REPO, "src"), join(probeDir, "src"), { recursive: true });

// 4) 清单
const manifest = {
  built_at: new Date().toISOString(),
  server: { path: "server", entry: "server/server.js", size_mb: toMB(dirBytes(serverDir)) },
  probe: { path: "probe", entry: "probe/ext/index.ts", size_mb: toMB(dirBytes(probeDir)) },
  dropped,
};
writeFileSync(join(RESOURCES, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify(manifest, null, 2));
console.log(`\n资源目录：${RESOURCES}`);
