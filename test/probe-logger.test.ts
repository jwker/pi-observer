import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProbeLogger, probeLogDir } from "../ext/logger.ts";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-observer-log-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("日志默认只写文件，不碰 stderr", () => {
  const { dir, cleanup } = tempDir();
  try {
    const logger = createProbeLogger({ dir, toStderr: false });
    logger.log("批次被拒绝，已丢弃 7 条");

    const file = join(dir, "probe.log");
    assert.ok(existsSync(file), "日志文件已创建");
    const text = readFileSync(file, "utf8");
    assert.match(text, /\[pi-observer\] 批次被拒绝，已丢弃 7 条/);
    assert.match(text, /^\d{4}-\d{2}-\d{2}T/, "每行带 ISO 时间");
  } finally {
    cleanup();
  }
});

test("日志目录与令牌同目录；文件名可改", () => {
  assert.equal(probeLogDir("/a/b/token"), "/a/b");
  const { dir, cleanup } = tempDir();
  try {
    const logger = createProbeLogger({ dir, toStderr: false, name: "other.log" });
    logger.log("x");
    assert.ok(existsSync(join(dir, "other.log")));
  } finally {
    cleanup();
  }
});

test("日志轮转：超过上限就改名成 .1，只保留最近两代", () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = join(dir, "probe.log");
    // 先塞一个超过 1 MB 的文件，触发下一条写入时的轮转
    writeFileSync(file, "x".repeat(1024 * 1024 + 10), "utf8");

    const logger = createProbeLogger({ dir, toStderr: false });
    logger.log("新的一条");

    assert.ok(existsSync(`${file}.1`), "旧文件被改名成 .1");
    assert.match(readFileSync(file, "utf8"), /新的一条/);
    assert.equal(readFileSync(`${file}.1`, "utf8").length, 1024 * 1024 + 10);
  } finally {
    cleanup();
  }
});

test("写不了日志时不抛错，也不静默丢弃到没影", () => {
  const { dir, cleanup } = tempDir();
  try {
    // 目录存在但不可写（用文件占位，让 mkdir 失败）
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a dir", "utf8");

    const logger = createProbeLogger({ dir: join(blocked, "sub"), toStderr: false });
    assert.doesNotThrow(() => logger.log("写不进去也要活着"));
  } finally {
    cleanup();
  }
});
