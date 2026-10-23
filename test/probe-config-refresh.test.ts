import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PROBE_CONFIG_VERSION,
  probeConfigPath,
  readProbeFileConfig,
  serverProbeConfig,
  startProbeConfigRefresh,
  stopProbeConfigRefresh,
  writeProbeConfigIfChanged,
  writeProbeFileConfig,
} from "../src/lib/probe-config.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-observer-probe-refresh-"));
}

test("服务端配置：地址、令牌路径与正文目录都指向数据目录", () => {
  const config = serverProbeConfig("/data", 52731, "127.0.0.1");
  assert.equal(config.version, PROBE_CONFIG_VERSION);
  assert.equal(config.baseUrl, "http://127.0.0.1:52731");
  assert.equal(config.tokenFile, "/data/token");
  assert.equal(config.payloadDir, "/data/payloads");
});

test("内容没变就不重写：省掉无谓的磁盘写入", () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);
  const config = serverProbeConfig(dir, 4173, "127.0.0.1");

  assert.equal(writeProbeConfigIfChanged(path, config), true, "第一次要写");
  const first = statSync(path).mtimeMs;

  assert.equal(writeProbeConfigIfChanged(path, config), false, "内容一样不写");
  assert.equal(statSync(path).mtimeMs, first, "文件没被动过");

  // 端口变了 → 要写
  assert.equal(writeProbeConfigIfChanged(path, serverProbeConfig(dir, 52731, "127.0.0.1")), true);
  const read = readProbeFileConfig(path);
  assert.equal(read?.baseUrl, "http://127.0.0.1:52731");
});

test("定期刷新：别的实例写坏了地址后，活着的服务能把它纠正回来", async () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);

  // 服务启动：写出自己的地址
  writeProbeFileConfig(path, serverProbeConfig(dir, 4173, "127.0.0.1"));

  // 另一个服务实例（开发服务）写了同一个文件，然后退出了：地址留在那儿，但那个服务没了
  writeProbeFileConfig(path, serverProbeConfig(dir, 5999, "127.0.0.1"));
  assert.equal(readProbeFileConfig(path)?.baseUrl, "http://127.0.0.1:5999");

  // 还活着的服务定期刷新 → 地址被纠正回来
  startProbeConfigRefresh(dir, 4173, "127.0.0.1", 50);
  await new Promise((resolve) => setTimeout(resolve, 300));
  stopProbeConfigRefresh();

  assert.equal(readProbeFileConfig(path)?.baseUrl, "http://127.0.0.1:4173");
});

test("定期刷新：内容没变时不反复重写", async () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);
  writeProbeConfigIfChanged(path, serverProbeConfig(dir, 4173, "127.0.0.1"));
  const before = statSync(path).mtimeMs;

  startProbeConfigRefresh(dir, 4173, "127.0.0.1", 50);
  await new Promise((resolve) => setTimeout(resolve, 300));
  stopProbeConfigRefresh();

  assert.equal(statSync(path).mtimeMs, before, "地址没变就不该重写");
  // 顺带确认文件内容还是好的（没被写坏）
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.includes("http://127.0.0.1:4173"));
});

test("定期刷新：写坏了也不抛，保留旧地址", async () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);
  // 故意把 probe.json 写成非法 JSON：读的时候当没有
  writeFileSync(path, "{不是 JSON", "utf8");

  startProbeConfigRefresh(dir, 4173, "127.0.0.1", 50);
  await new Promise((resolve) => setTimeout(resolve, 300));
  stopProbeConfigRefresh();

  const read = readProbeFileConfig(path);
  assert.equal(read?.baseUrl, "http://127.0.0.1:4173", "应该被刷新成正确的地址");
});

test("两个服务同时跑时不互相抢：地址还活着就别动它", async () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);

  // 另一个服务在某个端口上活着
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  writeProbeFileConfig(path, {
    version: PROBE_CONFIG_VERSION,
    baseUrl: `http://127.0.0.1:${port}`,
    tokenFile: join(dir, "token"),
    payloadDir: join(dir, "payloads"),
  });

  startProbeConfigRefresh(dir, 4173, "127.0.0.1", 50);
  await new Promise((resolve) => setTimeout(resolve, 300));
  stopProbeConfigRefresh();

  assert.equal(
    readProbeFileConfig(path)?.baseUrl,
    `http://127.0.0.1:${port}`,
    "那个服务还活着，地址就不该被抢走",
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("那个服务没了：活着的服务接手地址", async () => {
  const dir = tempDir();
  const path = probeConfigPath(dir);

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  writeProbeFileConfig(path, {
    version: PROBE_CONFIG_VERSION,
    baseUrl: `http://127.0.0.1:${port}`,
    tokenFile: join(dir, "token"),
    payloadDir: join(dir, "payloads"),
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));

  startProbeConfigRefresh(dir, 4173, "127.0.0.1", 50);
  await new Promise((resolve) => setTimeout(resolve, 300));
  stopProbeConfigRefresh();

  assert.equal(readProbeFileConfig(path)?.baseUrl, "http://127.0.0.1:4173", "该接手");
});
