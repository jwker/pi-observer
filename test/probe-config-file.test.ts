import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PROBE_CONFIG_FILE_NAME,
  PROBE_CONFIG_VERSION,
  probeConfigPath,
  readProbeFileConfig,
  writeProbeFileConfig,
} from "../src/lib/probe-config.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-observer-probe-config-"));
}

test("配置文件路径：放在数据目录下", () => {
  assert.equal(probeConfigPath("/tmp/data"), join("/tmp/data", PROBE_CONFIG_FILE_NAME));
});

test("写完能读回来，字段原样保留", () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);
  writeProbeFileConfig(path, {
    version: PROBE_CONFIG_VERSION,
    baseUrl: "http://127.0.0.1:52731",
    tokenFile: "/tmp/data/token",
    payloadDir: "/tmp/data/payloads",
  });
  const read = readProbeFileConfig(path);
  assert.ok(read !== null);
  assert.equal(read.version, PROBE_CONFIG_VERSION);
  assert.equal(read.baseUrl, "http://127.0.0.1:52731");
  assert.equal(read.tokenFile, "/tmp/data/token");
  assert.equal(read.payloadDir, "/tmp/data/payloads");
});

test("写文件会建目录、留下 0600 权限，并且不留临时文件", () => {
  const dir = tempDir();
  const path = probeConfigPath(join(dir, "nested", "data"));
  writeProbeFileConfig(path, { version: PROBE_CONFIG_VERSION, baseUrl: "http://127.0.0.1:4173" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => readFileSync(`${path}.tmp`));
});

test("覆盖写是原子的：读到的永远是完整 JSON", () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);
  for (let i = 0; i < 20; i++) {
    writeProbeFileConfig(path, {
      version: PROBE_CONFIG_VERSION,
      baseUrl: `http://127.0.0.1:${4000 + i}`,
      tokenFile: "/tmp/data/token",
      payloadDir: "/tmp/data/payloads",
    });
    const read = readProbeFileConfig(path);
    assert.ok(read !== null);
    assert.equal(read.baseUrl, `http://127.0.0.1:${4000 + i}`);
  }
});

test("文件不存在、不是合法 JSON、不是对象，都当作没有配置", () => {
  const dir = tempDir();
  assert.equal(readProbeFileConfig(probeConfigPath(dir)), null);

  const broken = probeConfigPath(dir);
  writeFileSync(broken, "{不是 JSON", "utf8");
  assert.equal(readProbeFileConfig(broken), null);

  const array = probeConfigPath(dir);
  writeFileSync(array, "[1,2,3]", "utf8");
  assert.equal(readProbeFileConfig(array), null);
});

test("单个字段不合法时只丢这一个字段", () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      baseUrl: "file:///etc/passwd",
      tokenFile: "相对路径/token",
      payloadDir: "/tmp/data/payloads",
    }),
    "utf8",
  );
  const read = readProbeFileConfig(path);
  assert.ok(read !== null);
  assert.equal(read.baseUrl, undefined, "非 http 地址不算服务地址");
  assert.equal(read.tokenFile, undefined, "相对路径不算令牌路径");
  assert.equal(read.payloadDir, "/tmp/data/payloads", "合法字段照常用");
});

test("地址末尾多余的斜杠会去掉", () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);
  writeFileSync(path, JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:4173/" }), "utf8");
  const read = readProbeFileConfig(path);
  assert.ok(read !== null);
  assert.equal(read.baseUrl, "http://127.0.0.1:4173");
});
