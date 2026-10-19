/**
 * 档 B：消息数与 Pi 自己的视图一致（PRD §14 M2 第 1 条）。
 *
 * 「Pi 自带的 /tree」渲染的是会话文件的 `{header, entries, leafId}` 模型。`pi --export`
 * 生成的 HTML 里内嵌了这份数据（base64 的 `<script id="session-data">`），所以不需要人工
 * 打开 TUI 对照——直接拿 Pi 自己导出的数据模型与看板逐条比对：
 *
 *   1. 条目 id 与顺序一致；
 *   2. `type === "message"` 的条目数 = 库里的 `message_count`；
 *   3. `leafId`（当前分支的叶）= 我们按行号取的最后一条；
 *   4. 头部 `id` / `cwd` 与库里一致。
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
  // 先让页面路径补读一次，避免「文件比库新」造成的假不一致
  await fetch(`${base}/sessions/${encodeURIComponent(session.session_id)}`).catch(() => {});

  const pi = piSessionData(session.file_path);
  const ours = await json(
    `${base}/api/sessions/${encodeURIComponent(session.session_id)}/messages?limit=20000`,
  );

  const piIds = (pi.entries ?? []).map((entry) => entry.id);
  const ourIds = (ours.messages ?? []).map((row) => row.entry_id);
  const piMessages = (pi.entries ?? []).filter((entry) => entry.type === "message").length;
  const ourLeaf = ourIds.length === 0 ? null : ourIds[ourIds.length - 1];

  const sameIds = piIds.length === ourIds.length && piIds.every((id, index) => id === ourIds[index]);
  const sameCount = piMessages === session.message_count;
  const sameLeaf = (pi.leafId ?? null) === ourLeaf;
  const sameHeader = pi.header?.id === session.session_id && text(pi.header?.cwd) === text(session.cwd);

  const ok = sameIds && sameCount && sameLeaf && sameHeader;
  if (!ok) failures += 1;

  rows.push({
    ok,
    会话: session.session_id.slice(0, 12),
    "Pi 条目": piIds.length,
    库里条目: ourIds.length,
    "Pi 消息": piMessages,
    库里消息: session.message_count,
    leaf: sameLeaf ? "一致" : `${pi.leafId ?? "—"} ≠ ${ourLeaf ?? "—"}`,
  });

  if (!ok) {
    console.log(`✘ ${session.session_id}`);
    console.log(`  条目 ${piIds.length} vs ${ourIds.length}（${sameIds ? "id 与顺序一致" : "id 或顺序不一致"}）`);
    console.log(`  消息 ${piMessages} vs ${session.message_count}`);
    console.log(`  leaf ${pi.leafId ?? "—"} vs ${ourLeaf ?? "—"}`);
    console.log(`  头部 id/cwd ${sameHeader ? "一致" : "不一致"}（Pi cwd=${pi.header?.cwd}，库里 cwd=${session.cwd}）`);
  }
}

console.table(rows);

const totalPi = rows.reduce((sum, row) => sum + row["Pi 条目"], 0);
const totalOur = rows.reduce((sum, row) => sum + row["库里条目"], 0);
const totalPiMessages = rows.reduce((sum, row) => sum + row["Pi 消息"], 0);

console.log(
  `\n${failures === 0 ? "✔" : "✘"} 逐条对照：${rows.length} 个会话、${totalPi} 条条目、${totalPiMessages} 条消息；` +
    `库里 ${totalOur} 条条目${failures === 0 ? "，全部一致" : `，${failures} 个会话不一致`}`,
);

process.exit(failures === 0 ? 0 : 1);
