/**
 * 下载 Electron 的二进制。
 *
 * 为什么单独写这个脚本：
 *   - Electron 45 的 npm 包里没有 postinstall，装完不会自动下二进制，
 *     要另外跑 `install-electron`；
 *   - 二进制默认从 GitHub 下载，国内不稳。这里默认走 npmmirror，
 *     想用官方源就设 `ELECTRON_MIRROR` 覆盖。
 *
 * 用法：在 desktop/ 目录下执行 `node ../tools/desktop/install-electron.mjs`
 * （desktop 的 postinstall 已经调它）。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "..", "..", "desktop");

process.env.ELECTRON_MIRROR ??= "https://npmmirror.com/mirrors/electron/";

const require = createRequire(join(DESKTOP, "package.json"));
const installPath = require.resolve("electron/install.js");
console.log(`下载 Electron 二进制（镜像：${process.env.ELECTRON_MIRROR}）`);
await import(`file://${installPath}`);
