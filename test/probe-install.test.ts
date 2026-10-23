import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installProbe, probeInstallStatus, uninstallProbe } from "../src/lib/probe-install.ts";

/**
 * 这些测试要写文件，所以把「数据目录」与「Pi 的 agent 目录」都指到临时目录。
 * `config()` 是进程内单例，第一次读环境变量之后就固定了——
 * 所以整个文件共用一组环境变量，测试之间不换目录。
 */
const root = mkdtempSync(join(tmpdir(), "pi-observer-install-"));
const dataDir = join(root, "data");
const agentDir = join(root, "agent");
const sourceDir = join(root, "source");

process.env.PI_OBSERVER_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OBSERVER_PROBE_DIR = sourceDir;

// 造一份「探针源码」：结构要跟仓库里一样（ext/ 与 src/）
mkdirSync(join(sourceDir, "ext"), { recursive: true });
writeFileSync(join(sourceDir, "ext", "index.ts"), "export default function probe() {}\n", "utf8");
mkdirSync(join(sourceDir, "src", "lib"), { recursive: true });
writeFileSync(join(sourceDir, "src", "lib", "protocol.ts"), "export const X = 1;\n", "utf8");

test("没装的时候：状态里入口文件与探针代码都不在", () => {
  const status = probeInstallStatus();
  assert.equal(status.extensionExists, false);
  assert.equal(status.codeInstalled, false);
  assert.equal(status.extensionOwned, false);
  assert.equal(status.extensionPath, join(agentDir, "extensions", "pi-observer.ts"));
  assert.equal(status.probeDir, join(dataDir, "probe"));
});

test("安装：复制探针代码、写入口文件、状态变已安装", () => {
  const result = installProbe();
  assert.equal(result.ok, true, result.message);

  const status = probeInstallStatus();
  assert.equal(status.extensionExists, true);
  assert.equal(status.extensionOwned, true);
  assert.equal(status.codeInstalled, true);

  // 代码复制到位，相对导入的结构没断
  assert.equal(existsSync(join(dataDir, "probe", "ext", "index.ts")), true);
  assert.equal(existsSync(join(dataDir, "probe", "src", "lib", "protocol.ts")), true);

  // 入口文件转发到装好的位置，不是指向源码目录
  const content = readFileSync(status.extensionPath, "utf8");
  assert.ok(content.includes(join(dataDir, "probe", "ext", "index.ts")));
  assert.ok(!content.includes(sourceDir), "入口文件不该指向源码目录");
});

test("重装：覆盖旧版本，不留上一次的残留文件", () => {
  const stale = join(dataDir, "probe", "ext", "stale.ts");
  writeFileSync(stale, "// 上一版留下的\n", "utf8");

  const result = installProbe();
  assert.equal(result.ok, true, result.message);
  assert.equal(existsSync(stale), false, "重装要先清掉旧目录");
  assert.equal(existsSync(join(dataDir, "probe", "ext", "index.ts")), true);
});

test("入口文件是别人写的：先问，不擅自覆盖", () => {
  const foreign = join(agentDir, "extensions", "pi-observer.ts");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(foreign, "// 用户自己写的探针\n", "utf8");

  const status = probeInstallStatus();
  assert.equal(status.extensionExists, true);
  assert.equal(status.extensionOwned, false, "不是我们写的就不算自己的");

  const blocked = installProbe();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.needsConfirm, true);
  assert.equal(readFileSync(foreign, "utf8"), "// 用户自己写的探针\n", "不能被偷偷改掉");

  // 明确同意才覆盖
  const forced = installProbe({ overwrite: true });
  assert.equal(forced.ok, true, forced.message);
  assert.equal(probeInstallStatus().extensionOwned, true);
});

test("卸载：删入口文件与探针代码，数据默认保留", () => {
  const result = uninstallProbe();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.dataRemoved, false);
  assert.equal(existsSync(join(dataDir, "probe")), false, "探针代码要删掉");
  assert.equal(existsSync(join(agentDir, "extensions", "pi-observer.ts")), false, "入口文件要删掉");
  assert.equal(existsSync(dataDir), true, "数据目录默认保留");
});

test("卸载时可以连数据一起删", () => {
  // 先装回去，再带 removeData 卸载
  assert.equal(installProbe().ok, true);
  mkdirSync(join(dataDir, "payloads"), { recursive: true });
  writeFileSync(join(dataDir, "payloads", "x.json"), "{}", "utf8");

  const result = uninstallProbe({ removeData: true });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.dataRemoved, true);
  assert.equal(existsSync(dataDir), false, "数据目录整个删掉");
});

test("没装就卸载：不报错，也不删别人的入口文件", () => {
  const result = uninstallProbe();
  assert.equal(result.ok, true);
  assert.equal(result.dataRemoved, false);
});
