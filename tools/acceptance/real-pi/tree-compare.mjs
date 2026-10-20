/**
 * 档 B：消息数与 Pi 自己的视图一致（PRD §14 M2 第 1 条）。
 *
 * 「Pi 自带的 /tree」渲染的是会话文件的 `{header, entries, leafId}` 模型。`pi --export`
 * 生成的 HTML 里内嵌了这份数据（base64 的 `<script id="session-data">`），所以不需要人工
 * 打开 TUI 对照——直接拿 Pi 自己导出的数据模型与看板逐条比对：
 *
 *   1. 条目 id 与顺序一致；
 *   2. `type === "message"` 的条目数 = 库里索引里 `kind=message` 的行数（不看可能滞后的 sessions 汇总）；
 *   3. `leafId`（当前分支的叶）= 我们按行号取的最后一条；
 *   4. 头部 `id` / `cwd` 与库里一致；
 *   5. M3-5：从 entries 现算 token / 缓存读写 / 成本，与 `/turns` 返回的会话级 usage 一致。
 *
 * 前置：`npm run start` 在跑（只读接口），`pi` 在 PATH 上。
 * **不调用模型、不花钱**；会为每个会话生成一次 HTML 导出（写在临时目录，跑完删掉）。
 *
 * 用法：node tools/acceptance/real-pi/tree-compare.mjs [cwd 关键字]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.PI_OBSERVER_URL ?? "http://127.0.0.1:4173";
const keyword = process.argv[2] ?? "";
const root = join(homedir(), ".pi/agent/sessions");

/** 导出一次，拿回 Pi 自己的 session 数据模型 */
function piSessionData(path) {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-export-"));
  try {
    execFileSync("pi", ["--export", path], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    const htmlName = readdirSync(dir).find((name) => name.endsWith(".html"));
    if (!htmlName) throw new Error(`pi --export 没有生成 HTML：${path}`);
    const html = readFileSync(join(dir, htmlName), "utf8");
    const raw = /<script[^>]*id="session-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1]?.trim();
    if (!raw) throw new Error(`导出文件里没有 session-data：${path}`);
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.json();
}

const text = (value) => String(value ?? "");

/** 从 Pi 导出的 entries 里现算用量；只认 assistant 消息的 usage */
function piUsage(entries) {
  const total = { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost: 0 };
  for (const entry of entries ?? []) {
    if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (!usage || typeof usage !== "object") continue;
    total.tokens_in += typeof usage.input === "number" ? usage.input : 0;
    total.tokens_out += typeof usage.output === "number" ? usage.output : 0;
    total.cache_read += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
    total.cache_write += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
    total.cost += typeof usage.cost?.total === "number" ? usage.cost.total : 0;
  }
  return total;
}

const list = await json(`${base}/api/sessions?limit=1000`);
const withFile = (list.sessions ?? []).filter((row) => row.file_path && text(row.cwd).includes(keyword));
const sessions = withFile.filter((row) => existsSync(row.file_path));
const missing = withFile.filter((row) => !existsSync(row.file_path));

if (sessions.length === 0) {
  console.error(`没有可对照的会话（file_path 为空、文件不存在，或 cwd 不含 "${keyword}"）`);
  process.exit(1);
}

console.log(`看板：${base}｜对照 ${sessions.length} 个带会话文件的会话${keyword ? `（cwd 含 "${keyword}"）` : ""}\n`);
if (missing.length > 0) {
  console.log(`跳过 ${missing.length} 个「库里有 file_path 但文件已不在」的会话：`);
  for (const row of missing) console.log(`  · ${row.session_id.slice(0, 12)} → ${row.file_path}`);
  console.log("");
}

const rows = [];
let failures = 0;

for (const session of sessions) {
  // 先让取数路径补读一次，避免「文件比库新」造成的假不一致
  await fetch(`${base}/api/session?id=${encodeURIComponent(session.session_id)}`).catch(() => {});

  const pi = piSessionData(session.file_path);
  const ours = await json(`${base}/api/session?id=${encodeURIComponent(session.session_id)}`);
  const data = ours.data ?? {};
  const expectedUsage = piUsage(pi.entries);
  // 会话级用量 = 该会话所有 Turn 之和（与看板内部口径一致）
  const actualUsage = (data.turns ?? []).reduce(
    (total, turn) => ({
      tokens_in: total.tokens_in + (turn.tokens_in ?? 0),
      tokens_out: total.tokens_out + (turn.tokens_out ?? 0),
      cache_read: total.cache_read + (turn.cache_read ?? 0),
      cache_write: total.cache_write + (turn.cache_write ?? 0),
      cost: total.cost + (turn.cost ?? 0),
    }),
    { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost: 0 },
  );

  const piIds = (pi.entries ?? []).map((entry) => entry.id);
  const ourIds = (data.messages ?? []).map((row) => row.entry_id);
  const piMessages = (pi.entries ?? []).filter((entry) => entry.type === "message").length;
  const ourMessages = (data.messages ?? []).filter((row) => row.kind === "message").length;
  const ourLeaf = ourIds.length === 0 ? null : ourIds[ourIds.length - 1];

  const sameIds = piIds.length === ourIds.length && piIds.every((id, index) => id === ourIds[index]);
  const sameCount = piMessages === ourMessages;
  const sameLeaf = (pi.leafId ?? null) === ourLeaf;
  const sameHeader = pi.header?.id === session.session_id && text(pi.header?.cwd) === text(session.cwd);
  const sameUsage = [
    "tokens_in",
    "tokens_out",
    "cache_read",
    "cache_write",
  ].every((key) => Number(actualUsage[key] ?? 0) === Number(expectedUsage[key] ?? 0));
  const sameCost = Math.abs(Number(actualUsage.cost ?? 0) - expectedUsage.cost) < 1e-6;

  const ok = sameIds && sameCount && sameLeaf && sameHeader && sameUsage && sameCost;
  if (!ok) failures += 1;

  rows.push({
    ok,
    会话: session.session_id.slice(0, 12),
    "Pi 条目": piIds.length,
    库里条目: ourIds.length,
    "Pi 消息": piMessages,
    库里消息: ourMessages,
    leaf: sameLeaf ? "一致" : `${pi.leafId ?? "—"} ≠ ${ourLeaf ?? "—"}`,
    用量: sameUsage && sameCost ? "一致" : "不一致",
  });

  if (!ok) {
    console.log(`✘ ${session.session_id}`);
    console.log(`  条目 ${piIds.length} vs ${ourIds.length}（${sameIds ? "id 与顺序一致" : "id 或顺序不一致"}）`);
    console.log(`  消息 ${piMessages} vs ${ourMessages}`);
    console.log(`  leaf ${pi.leafId ?? "—"} vs ${ourLeaf ?? "—"}`);
    console.log(`  头部 id/cwd ${sameHeader ? "一致" : "不一致"}（Pi cwd=${pi.header?.cwd}，库里 cwd=${session.cwd}）`);
    if (!sameUsage || !sameCost) {
      console.log(
        `  用量 Pi=${JSON.stringify(expectedUsage)} 库里=${JSON.stringify(actualUsage)}`,
      );
    }
  }
}

console.table(rows);

const totalPi = rows.reduce((sum, row) => sum + row["Pi 条目"], 0);
const totalOur = rows.reduce((sum, row) => sum + row["库里条目"], 0);
const totalPiMessages = rows.reduce((sum, row) => sum + row["Pi 消息"], 0);

console.log(
  `\n${failures === 0 ? "✔" : "✘"} 逐条对照：${rows.length} 个会话、${totalPi} 条条目、${totalPiMessages} 条消息；` +
    `库里 ${totalOur} 条条目${failures === 0 ? "，条目与用量全部一致" : `，${failures} 个会话不一致`}`,
);

process.exit(failures === 0 ? 0 : 1);
