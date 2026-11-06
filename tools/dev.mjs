/**
 * 启动开发服务。
 *
 * 跟生产方式一样：端口默认 4173，被占用时自动换一个空闲端口，
 * 实际地址打印在日志第一行。
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT, HOST, findFreePort } from "./port.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

const wanted = Number(process.env.PORT ?? DEFAULT_PORT);
const { port, switched } = await findFreePort(Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_PORT, HOST);
if (switched) {
  console.log(`端口 ${wanted} 被占用，改用 ${port}`);
}
console.log(`看板地址 http://${HOST}:${port}`);

const bin = join(repo, "node_modules", ".bin", "next");
const child = spawn(bin, ["dev", "-H", HOST, "-p", String(port)], {
  cwd: repo,
  stdio: "inherit",
  env: { ...process.env, PORT: String(port) },
});

child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
