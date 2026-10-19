/**
 * 档 B：探针开销 A/B（PRD §14 M1 第 2 条，判据：两轮对话响应时间偏差 ≤ 10%）。
 *
 *   baseline 档：`pi -ne`（关掉全部扩展）          → 没有探针
 *   probe 档：   `pi --extension ./ext`            → 装了探针
 *
 * ⚠️ 会调用真实模型：默认 3 轮 × 2 条提示 × 2 种配置 = 12 次请求，会花掉 token 和时间。
 *
 * 前置：`pi` 在 PATH 上。不需要服务端（探针连不上服务端时会重试，不影响这项测量）。
 *
 * 用法：
 *   node tools/acceptance/real-pi/overhead.mjs [轮数]
 *
 * 两个指标：
 *   1. 模型响应时间 durationMs —— 来自 Pi 自己写进会话 JSONL 的字段（更贴近「卡不卡」）；
 *   2. pi 进程墙钟耗时 —— 含进程启动与扩展加载，噪声更大。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXT = join(REPO, "ext");
const ROUNDS = Number(process.argv[2] ?? 3);
const PROMPTS = ["只回答两个字：好的", "再回答两个字：收到"];
const JUDGE_PERCENT = 10;

const sessionDir = mkdtempSync(join(tmpdir(), "pi-observer-overhead-"));
const CONFIGS = [
  { name: "baseline", args: ["-ne"] },
  { name: "probe", args: ["--extension", EXT] },
];

function listJsonl(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonl(full));
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function durationsIn(file) {
  const found = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line);
      const value = entry?.message?.durationMs ?? entry?.durationMs;
      if (typeof value === "number") found.push(value);
    } catch {
      // 坏行跳过
    }
  }
  return found;
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
};

const results = {};
try {
  for (const config of CONFIGS) {
    results[config.name] = { wall: [], duration: [] };
    for (let round = 1; round <= ROUNDS; round += 1) {
      const sessionId = `overhead-${config.name}-${round}`;
      for (const prompt of PROMPTS) {
        const before = new Set(listJsonl(sessionDir));
        const start = performance.now();
        const run = spawnSync(
          "pi",
          ["-p", "-a", "--session-dir", sessionDir, "--session-id", sessionId, ...config.args, prompt],
          { encoding: "utf8", timeout: 180000 },
        );
        results[config.name].wall.push(Math.round(performance.now() - start));
        if (run.status !== 0) {
          console.error(`[${config.name}] 第 ${round} 轮失败：${String(run.stderr).slice(0, 200)}`);
        }

        const created = listJsonl(sessionDir).filter((file) => !before.has(file));
        const candidates = created.length > 0 ? created : listJsonl(sessionDir);
        const target = candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
        const durations = target ? durationsIn(target) : [];
        if (durations.length > 0) results[config.name].duration.push(durations[durations.length - 1]);
      }
    }
  }
} finally {
  rmSync(sessionDir, { recursive: true, force: true });
}

for (const [name, data] of Object.entries(results)) {
  console.log(
    `${name.padEnd(9)} 墙钟中位 ${median(data.wall)} ms（样本 ${data.wall.length}）| durationMs 中位 ${median(data.duration)} ms（样本 ${data.duration.length}）`,
  );
}

const baseWall = median(results.baseline.wall);
const probeWall = median(results.probe.wall);
const baseDur = median(results.baseline.duration);
const probeDur = median(results.probe.duration);

const report = (label, base, probe) => {
  if (!base || !probe) {
    console.log(`${label}：样本不足，无法判断`);
    return;
  }
  const percent = ((probe - base) / base) * 100;
  const verdict = Math.abs(percent) <= JUDGE_PERCENT ? "通过" : "不通过";
  console.log(`${label}偏差：${percent.toFixed(1)}%（判据 ≤ ±${JUDGE_PERCENT}%：${verdict}）`);
};

report("墙钟", baseWall, probeWall);
report("模型响应 durationMs", baseDur, probeDur);
