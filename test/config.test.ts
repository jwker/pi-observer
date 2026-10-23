import assert from "node:assert/strict";
import test from "node:test";

import { checkNodeVersion, loadConfig } from "../src/lib/config.ts";

test("默认配置：端口 4173、只监听 127.0.0.1、2 MB 批次上限", () => {
  const config = loadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4173);
  assert.equal(config.ingestMaxBytes, 2 * 1024 * 1024);
  assert.ok(config.dbPath.endsWith(".pi-observer/observer.db"), "数据目录默认在工程外");
  assert.ok(config.tokenPath.endsWith(".pi-observer/token"));
  assert.ok(config.sessionsDir.endsWith(".pi/agent/sessions"));
});

test("环境变量覆盖默认值", () => {
  const config = loadConfig({
    PORT: "5000",
    PI_OBSERVER_DATA_DIR: "/tmp/custom-data",
    PI_OBSERVER_SESSIONS_DIR: "/tmp/sessions",
    PI_OBSERVER_RETENTION_DAYS: "3",
    PI_OBSERVER_INGEST_MAX_BYTES: "1024",
  });
  assert.equal(config.port, 5000);
  assert.equal(config.dataDir, "/tmp/custom-data");
  assert.equal(config.dbPath, "/tmp/custom-data/observer.db");
  assert.equal(config.sessionsDir, "/tmp/sessions");
  assert.equal(config.ingestMaxBytes, 1024);
});

test("非法环境变量回落到默认值", () => {
  const config = loadConfig({ PORT: "abc", PI_OBSERVER_RETENTION_DAYS: "-1" });
  assert.equal(config.port, 4173);
});

test("Node 版本下界 24、上界 27", () => {
  assert.equal(checkNodeVersion("26.5.0").ok, true);
  assert.equal(checkNodeVersion("24.0.0").ok, true);
  assert.equal(checkNodeVersion("23.9.0").ok, false);
  assert.equal(checkNodeVersion("27.0.0").ok, false);
  assert.equal(checkNodeVersion("not-a-version").ok, false);
});
