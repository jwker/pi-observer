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
const ROUNDS = Number(process.argv[2] ?? 4);
const PROMPTS = ["只回答两个字：好的", "再回答两个字：收到"];
const JUDGE_PERCENT = 10;

const sessionDir = mkdtempSync(join(tmpdir(), "pi-observer-overhead-"));
const CONFIGS = [
  { name: "baseline", args: ["-ne"] },
  // -ne：不做扩展发现（否则用户级扩展目录里的探针会和 -e 叠加成两份）
  { name: "probe", args: ["-ne", "-e", EXT] },
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
for (const config of CONFIGS) results[config.name] = { wall: [], duration: [], cpu: [] };
const pairs = [];

/** 从 `/usr/bin/time -p` 的 stderr 里取 user + sys（秒） */
function cpuSeconds(stderr) {
  let total = 0;
  let found = false;
  for (const line of String(stderr).split("\n")) {
    const match = line.match(/^(user|sys)\s+([\d.]+)\s*$/);
    if (match) {
      total += Number(match[2]);
      found = true;
    }
  }
  return found ? total : null;
}

function runConfig(config, label) {
  const sessionId = `overhead-${config.name}-${label}`;
  let wall = 0;
  let cpu = 0;
  let cpuOk = true;
  let lastDuration = null;
  for (const prompt of PROMPTS) {
    const before = new Set(listJsonl(sessionDir));
    const start = performance.now();
    // 用 /usr/bin/time 取进程 CPU 时间：模型响应时间受 provider 抖动影响太大，
    // CPU 才是探针自己真正占用的部分。
    const run = spawnSync(
      "/usr/bin/time",
      ["-p", "pi", "-p", "-a", "--session-dir", sessionDir, "--session-id", sessionId, ...config.args, prompt],
      { encoding: "utf8", timeout: 180000 },
    );
    wall += Math.round(performance.now() - start);
    const sampleCpu = cpuSeconds(run.stderr);
    if (sampleCpu === null) cpuOk = false;
    else cpu += sampleCpu;
    if (run.status !== 0) {
      console.error(`[${config.name}] 第 ${label} 轮失败：${String(run.stderr).slice(0, 200)}`);
    }

    const created = listJsonl(sessionDir).filter((file) => !before.has(file));
    const candidates = created.length > 0 ? created : listJsonl(sessionDir);
    const target = candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    const durations = target ? durationsIn(target) : [];
    if (durations.length > 0) lastDuration = durations[durations.length - 1];
  }
  return { wall, duration: lastDuration, cpu: cpuOk ? Math.round(cpu * 1000) : null };
}

try {
  // 成对测量：同一轮里两种配置紧挨着跑，奇数轮 baseline 先、偶数轮 probe 先。
  // 模型响应本身会随时间漂移（实测同一脚本两次跑出「探针快 60%」和「探针慢 4 倍」），
  // 所以只看两组中位数会被漂移盖过；这里再加一列「逐对相对差」的中位数。
  for (let round = 1; round <= ROUNDS; round += 1) {
    const order = round % 2 === 1 ? CONFIGS : [...CONFIGS].reverse();
    const pair = {};
    for (const config of order) {
      const sample = runConfig(config, `${round}`);
      results[config.name].wall.push(sample.wall);
      if (sample.duration !== null) results[config.name].duration.push(sample.duration);
      if (sample.cpu !== null) results[config.name].cpu.push(sample.cpu);
      pair[config.name] = sample;
    }
    if (pair.baseline && pair.probe) pairs.push(pair);
  }
} finally {
  rmSync(sessionDir, { recursive: true, force: true });
}

for (const [name, data] of Object.entries(results)) {
  console.log(
    `${name.padEnd(9)} 墙钟中位 ${median(data.wall)} ms（样本 ${data.wall.length}）| durationMs 中位 ${median(data.duration)} ms（样本 ${data.duration.length}）`,
  );
  console.log(`          墙钟样本：${data.wall.join(", ")}`);
  console.log(`          durationMs 样本：${data.duration.join(", ")}`);
  if (data.cpu.length > 0) {
    console.log(`          CPU 中位 ${median(data.cpu)} ms（样本 ${data.cpu.length}）：${data.cpu.join(", ")}`);
  }
}

const pairedPercent = (pick) =>
  median(
    pairs
      .filter((pair) => typeof pick(pair.baseline) === "number" && typeof pick(pair.probe) === "number")
      .map((pair) => ((pick(pair.probe) - pick(pair.baseline)) / pick(pair.baseline)) * 100),
  );

const report = (label, percent) => {
  if (percent === null || !Number.isFinite(percent)) {
    console.log(`${label}：样本不足，无法判断`);
    return;
  }
  const verdict = Math.abs(percent) <= JUDGE_PERCENT ? "通过" : "不通过";
  console.log(`${label}逐对偏差中位：${percent.toFixed(1)}%（判据 ≤ ±${JUDGE_PERCENT}%：${verdict}）`);
};

report("墙钟", pairedPercent((sample) => sample.wall));
report("模型响应 durationMs", pairedPercent((sample) => sample.duration));
report("进程 CPU", pairedPercent((sample) => sample.cpu));

console.log("\n说明：墙钟与 durationMs 受 provider 抖动影响很大（同一配置相邻两轮可差数倍），");
console.log("判据看 CPU：探针同步做的事只有两次 JSON 序列化与入队，CPU 增量应远小于 10%。");

console.log("\n逐对相对差（probe 相对 baseline，正数=探针更慢）：");
for (const pair of pairs) {
  const wall = ((pair.probe.wall - pair.baseline.wall) / pair.baseline.wall) * 100;
  const dur =
    typeof pair.baseline.duration === "number" && typeof pair.probe.duration === "number"
      ? ((pair.probe.duration - pair.baseline.duration) / pair.baseline.duration) * 100
      : null;
  const cpu =
    typeof pair.baseline.cpu === "number" && typeof pair.probe.cpu === "number" && pair.baseline.cpu > 0
      ? ((pair.probe.cpu - pair.baseline.cpu) / pair.baseline.cpu) * 100
      : null;
  console.log(
    `  墙钟 ${wall >= 0 ? "+" : ""}${wall.toFixed(1)}%｜durationMs ${dur === null ? "n/a" : `${dur >= 0 ? "+" : ""}${dur.toFixed(1)}%`}｜CPU ${cpu === null ? "n/a" : `${cpu >= 0 ? "+" : ""}${cpu.toFixed(1)}%`}`,
  );
}
