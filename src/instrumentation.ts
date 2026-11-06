/**
 * 服务启动时的检查。
 *
 * 项目没有数据库，也没有后台任务：数据在请求时从会话文件里读。
 * 启动时只做一件事——确认会话目录读得到，读不到就在日志里说清楚，
 * 不然页面只会显示「空列表」，看不出是目录路径不对。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { config } = await import("./lib/config.ts");
  const { listSessionPaths } = await import("./lib/session-files.ts");

  const cfg = config();
  const paths = listSessionPaths(cfg.sessionsDir);
  console.log(
    `[pi-observer] 会话目录 ${cfg.sessionsDir}：${paths.length} 个会话文件\n` +
      `[pi-observer] 请求正文目录 ${cfg.requestStoreDir}`,
  );
}
