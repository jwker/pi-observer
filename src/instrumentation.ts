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

  const [
    { createBackfillContext, scanSessionsDir },
    { log },
    { startSessionSync },
    { endSessionsWithoutFile },
    { getDb },
    { applyRetention, startRetentionJobs },
    { config },
    { payloadsRoot, tightenPayloadPermissions },
    { PROBE_CONFIG_VERSION, probeConfigPath, writeProbeFileConfig },
  ] = await Promise.all([
    import("./lib/backfill.ts"),
    import("./lib/log.ts"),
    import("./lib/session-sync.ts"),
    import("./lib/session-state.ts"),
    import("./lib/db.ts"),
    import("./lib/retention.ts"),
    import("./lib/config.ts"),
    import("./lib/payload-files.ts"),
    import("./lib/probe-config.ts"),
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

  // 探针被强杀时收不到 agent_settled / session_shutdown，会话会永远停在「进行中」。
  // 文件没了就说明会话不可能还在跑——启动时顺手把这类状态改回「已结束」。
  try {
    const outcome = endSessionsWithoutFile(getDb());
    if (outcome.ended.length > 0) {
      log("info", "state", "已修正过期状态", { count: outcome.ended.length });
    }
  } catch (error) {
    log("warn", "state", "修正过期状态失败", { error: (error as Error).message });
  }

  // 保留期清理：payload 与事件只留 7 天（PRD §8.6）。启动时跑一次，之后每小时一次。
  try {
    applyRetention(getDb());
    startRetentionJobs(getDb());
  } catch (error) {
    log("warn", "retention", "保留期清理失败", { error: (error as Error).message });
  }

  // 正文是原样请求体（含系统提示与全部对话历史），不脱敏也不自动清理：
  // 收紧权限，旧的 0644 文件也一并改掉。
  try {
    const changed = tightenPayloadPermissions(payloadsRoot(config().dataDir));
    if (changed > 0) {
      log("info", "storage", "已收紧正文文件权限", { files: changed });
    }
  } catch (error) {
    log("warn", "storage", "收紧正文文件权限失败", { error: (error as Error).message });
  }

  // 探针要知道往哪推数据：把自己的地址与正文目录写进配置文件。
  // 探针跑在用户的 Pi 进程里，桌面版没法给它注入环境变量，只能靠这个文件。
  try {
    const cfg = config();
    const path = probeConfigPath(cfg.dataDir);
    writeProbeFileConfig(path, {
      version: PROBE_CONFIG_VERSION,
      baseUrl: `http://${cfg.host}:${cfg.port}`,
      tokenFile: cfg.tokenPath,
      payloadDir: payloadsRoot(cfg.dataDir),
    });
    log("info", "probe", "已写出探针配置", { path, base_url: `http://${cfg.host}:${cfg.port}` });
  } catch (error) {
    log("warn", "probe", "写探针配置失败", { error: (error as Error).message });
  }

  // 启动扫描之后开始每秒跟进活跃会话；已有循环时是幂等的。
  startSessionSync();
}
