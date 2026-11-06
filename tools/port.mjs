/**
 * 端口选择：优先用想要的端口，占用了就换一个空闲的。
 *
 * 为什么要有这个：本地服务经常和别的东西撞端口（开发工具、别的服务、
 * 上一次没退干净的进程）。撞了就直接启动失败，对使用者没有价值。
 * 这里改成自动换一个，并把实际地址打印出来。
 */
import { createServer } from "node:net";

/** 默认端口 */
export const DEFAULT_PORT = 4173;

/**
 * 挑一个能用的端口。
 *
 * 想要的那个能绑上就返回它；绑不上（端口被占）就随便找一个空闲端口。
 * 绑定后再放开，中间有一个极短的竞态窗口——本地单用户场景够用。
 */
export function findFreePort(preferred = DEFAULT_PORT, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        // 想要的端口被占：换一个随机的
        const fallback = createServer();
        fallback.on("error", reject);
        fallback.listen(0, host, () => {
          const { port } = fallback.address();
          fallback.close(() => resolve({ port, switched: true }));
        });
        return;
      }
      reject(error);
    });
    server.listen(preferred, host, () => {
      server.close(() => resolve({ port: preferred, switched: false }));
    });
  });
}

/** 服务只监听回环地址 */
export const HOST = "127.0.0.1";
