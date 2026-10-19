/**
 * 服务启动时扫描会话目录一次（PRD §9.1）。
 *
 * 几点取舍：
 *   - 只在 Node 运行时执行，构建阶段跳过（`next build` 不需要库）；
 *   - 用动态 `import` 而不是顶层 `import`：这个文件在 Edge 与 Node 两个上下文里都会被加载，
 *     而 `node:fs` / `node:sqlite` 只在 Node 侧存在；
 *   - 扫描是同步的（读文件 + 写库，中间没有 await），期间不会让出事件循环，
 *     所以不用担心和请求触发的同一次扫描交错在同一个连接上开两个事务。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const [{ createBackfillContext, scanSessionsDir }, { log }] = await Promise.all([
    import("./lib/backfill.ts"),
    import("./lib/log.ts"),
  ]);

  try {
    const ctx = createBackfillContext({ onWarning: (message) => log("warn", "backfill", message) });
    const summary = scanSessionsDir(ctx);
    log("info", "backfill", "启动扫描完成", {
      root: summary.root,
      files: summary.files,
      skipped: summary.skipped,
      changed: summary.changed,
      entries: summary.entries,
      sessions: summary.sessionIds.length,
      warnings: summary.warnings.length,
      took_ms: summary.tookMs,
    });
  } catch (error) {
    // 扫不动不能拖垮服务：页面里的补读与实时探针都不依赖它
    log("error", "backfill", "启动扫描失败", { error: (error as Error).message });
  }
}
