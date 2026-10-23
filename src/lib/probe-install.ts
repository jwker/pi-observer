/**
 * 桌面版的探针安装与卸载。
 *
 * 探针是 Pi 的扩展：Pi 启动时扫描 `<agent-dir>/extensions/` 下的 `.ts` / `.js` 文件并加载。
 * 所以「安装探针」实际上就三件事：
 *   1. 把探针代码复制到一个稳定位置（`<数据目录>/probe/`）；
 *   2. 在 `<agent-dir>/extensions/` 写一个入口文件，转发到那个稳定位置；
 *   3. 告诉用户「重开 Pi 会话才生效」。
 *
 * 为什么入口文件要指向稳定位置而不是应用包内部：
 * 应用会被移动、升级、删除，路径一变扩展就失效了。
 *
 * 为什么不自动装：写用户的 Pi 配置目录是有副作用的操作，必须由人明确点一下。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { config } from "./config.ts";

/** 复制过去的探针目录里放一个标记文件：卸载时据此判断这是不是我们装的 */
const MARKER_NAME = ".installed-by-pi-observer";

/** 入口文件名：Pi 只加载 extensions 目录下的 .ts / .js */
const EXTENSION_FILE_NAME = "pi-observer.ts";

export interface ProbeInstallStatus {
  /** 探针代码装在哪儿 */
  probeDir: string;
  /** Pi 的扩展入口文件 */
  extensionPath: string;
  /** 入口文件在不在 */
  extensionExists: boolean;
  /** 入口文件是不是我们写的（别人写的不能乱动） */
  extensionOwned: boolean;
  /** 探针代码有没有复制到位 */
  codeInstalled: boolean;
  /** Pi 的 agent 目录 */
  agentDir: string;
  /** 数据目录 */
  dataDir: string;
  /** 改动什么时候做的（ISO），用来告诉用户「重开 Pi 生效」 */
  updatedAt: string | null;
}

/** Pi 的 agent 目录：Pi 自己认这个环境变量 */
export function agentDir(): string {
  const custom = process.env.PI_CODING_AGENT_DIR?.trim();
  return custom !== undefined && custom !== "" ? custom : join(homedir(), ".pi", "agent");
}

/**
 * 探针源码在哪儿。
 *
 * 桌面版：应用包里的 `Resources/probe`（由主进程用环境变量指过来）。
 * 开发时：仓库根目录（`ext/` 与 `src/` 都在里面）。
 */
export function probeSourceDir(): string {
  const custom = process.env.PI_OBSERVER_PROBE_DIR?.trim();
  if (custom !== undefined && custom !== "") return resolve(custom);
  return process.cwd();
}

/** 入口文件里写什么：转发到装好的探针代码 */
function extensionSource(probeDir: string): string {
  const entry = join(probeDir, "ext", "index.ts");
  return [
    "/**",
    " * pi-observer 探针的个人扩展入口（由桌面版安装）。",
    " *",
    " * 只做转发：实现在 ~/.pi-observer/probe/ 下，更新桌面版即可生效。",
    " * 想停用就把本文件删掉或改名（Pi 只加载 *.ts / *.js）。",
    " */",
    `export { default } from ${JSON.stringify(entry)};`,
    "",
  ].join("\n");
}

/** 现在是什么状态 */
export function probeInstallStatus(): ProbeInstallStatus {
  const cfg = config();
  const probeDir = join(cfg.dataDir, "probe");
  const agent = agentDir();
  const extensionPath = join(agent, "extensions", EXTENSION_FILE_NAME);

  const extensionExists = existsSync(extensionPath);
  let extensionOwned = false;
  let updatedAt: string | null = null;
  if (extensionExists) {
    try {
      const content = readFileSync(extensionPath, "utf8");
      // 我们写的入口文件里一定有探针代码的路径
      extensionOwned = content.includes(join(probeDir, "ext"));
      updatedAt = statSync(extensionPath).mtime.toISOString();
    } catch {
      extensionOwned = false;
    }
  }

  return {
    probeDir,
    extensionPath,
    extensionExists,
    extensionOwned,
    codeInstalled: existsSync(join(probeDir, "ext", "index.ts")),
    agentDir: agent,
    dataDir: cfg.dataDir,
    updatedAt,
  };
}

export interface InstallResult {
  ok: boolean;
  status: ProbeInstallStatus;
  /** 要告诉用户的话 */
  message: string;
  /** 需要用户确认才能做的事（比如覆盖别人写的入口文件） */
  needsConfirm?: boolean;
}

/**
 * 安装探针。
 *
 * `overwrite` 为 false 时，碰到不是我们写的入口文件就停下来问，不擅自覆盖。
 */
export function installProbe(options: { overwrite?: boolean } = {}): InstallResult {
  const status = probeInstallStatus();
  if (status.extensionExists && !status.extensionOwned && options.overwrite !== true) {
    return {
      ok: false,
      needsConfirm: true,
      status,
      message: `${status.extensionPath} 已经存在，但不是桌面版装的。确认要覆盖吗？`,
    };
  }

  const source = probeSourceDir();
  const entry = join(source, "ext", "index.ts");
  if (!existsSync(entry)) {
    return {
      ok: false,
      status,
      message: `找不到探针源码（${entry}）。桌面版应该把 PI_OBSERVER_PROBE_DIR 指向应用包里的 probe 目录。`,
    };
  }

  try {
    // 先删旧的再复制：免得上一版留下的文件还在
    rmSync(status.probeDir, { recursive: true, force: true });
    mkdirSync(status.probeDir, { recursive: true });
    cpSync(join(source, "ext"), join(status.probeDir, "ext"), { recursive: true });
    // 探针会 import ../src/lib/*.ts，相对路径不能断
    cpSync(join(source, "src"), join(status.probeDir, "src"), { recursive: true });
    writeFileSync(join(status.probeDir, MARKER_NAME), new Date().toISOString(), "utf8");

    mkdirSync(dirname(status.extensionPath), { recursive: true });
    writeFileSync(status.extensionPath, extensionSource(status.probeDir), "utf8");
  } catch (error) {
    return { ok: false, status, message: `安装失败：${(error as Error).message}` };
  }

  return {
    ok: true,
    status: probeInstallStatus(),
    message: "探针已安装。已经在运行的 Pi 不会立刻加载它，重开一个 Pi 会话才生效。",
  };
}

export interface UninstallResult {
  ok: boolean;
  status: ProbeInstallStatus;
  message: string;
  /** 数据目录里的正文与库要不要一起删 */
  dataRemoved: boolean;
}

/**
 * 卸载探针。
 *
 * `removeData` 为 true 时连数据目录一起删（正文文件、库、令牌都没了，历史不可恢复）。
 * 默认不动数据：探针停了不等于历史要消失。
 */
export function uninstallProbe(options: { removeData?: boolean } = {}): UninstallResult {
  const status = probeInstallStatus();
  if (!status.extensionExists && !status.codeInstalled) {
    return { ok: true, status, message: "探针本来就没装。", dataRemoved: false };
  }

  try {
    // 入口文件不是我们写的就别动
    if (status.extensionExists && status.extensionOwned) {
      rmSync(status.extensionPath, { force: true });
    }
    if (status.codeInstalled) {
      rmSync(status.probeDir, { recursive: true, force: true });
    }
  } catch (error) {
    return { ok: false, status, message: `卸载失败：${(error as Error).message}`, dataRemoved: false };
  }

  let dataRemoved = false;
  if (options.removeData === true) {
    try {
      rmSync(status.dataDir, { recursive: true, force: true });
      dataRemoved = true;
    } catch {
      // 数据删不掉不算卸载失败：探针已经停了
    }
  }

  const message = dataRemoved
    ? "探针已卸载，数据目录也一并删除了。"
    : "探针已卸载。数据目录保留着，重装后还能看到历史。";
  return { ok: true, status: probeInstallStatus(), message, dataRemoved };
}
