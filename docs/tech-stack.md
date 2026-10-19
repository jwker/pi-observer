# pi-observer 技术选型

| 项 | 内容 |
|:--|:--|
| 版本 | v1（2026-10-19） |
| 适用 | pi-observer PRD v0.2 |
| 依据 | 本机实测（macOS 27.0.1 / Apple M1 Pro / Node v26.5.0），见附录 A |
| 状态 | 待确认 1 项（T1），其余为建议结论 |
| 原则 | 单用户、单机、只读、回环访问；优先使用 Node 内置能力，能不引依赖就不引 |

---

## 0. 结论速览

| 编号 | 项目 | 结论 | 是否偏离 PRD v0.2 |
|:--|:--|:--|:--|
| T1 | 应用形态 | **建议**：`node:http` + 原生前端（原型文件即界面），无构建、零依赖。备选：Next.js（PRD 原文） | **偏离，需你确认** |
| T2 | 运行时 | Node ≥ 24（本机 26.5.0），ESM，无打包器 | 一致（PRD §12） |
| T3 | 语言 | TypeScript 由 Node 类型擦除直接运行，无 `tsc`、无构建步骤 | 一致，实现方式更轻 |
| T4 | 存储 | `node:sqlite`（内置 SQLite 3.53.3），WAL，自写 SQL，无 ORM | 一致（D1 / C3） |
| T5 | 接口与实时 | `POST /api/ingest`（批量 + 令牌）；服务 → 浏览器的单向推送用 SSE，不用 WebSocket | 一致（PRD §10） |
| T6 | 前端 | 原生 HTML/CSS/JS，直接复用 `prototype/` 的样式与交互 | 与 PRD 的 "Next.js" 隐含冲突，随 T1 |
| T7 | 校验与配置 | 手写校验函数；`process.env` + 默认值，不引 zod / dotenv | 新增细节 |
| T8 | 测试 | `node --test` + `node:assert/strict`，不引 vitest / jest | 新增细节 |
| T9 | 日志 | 单行 JSON 写 stderr，不引日志库 | 新增细节 |
| T10 | 运行 | `node src/server.ts`；开发用 `node --watch`；不默认装守护进程 | 细节化 PRD §12 |
| T11 | 依赖 | 运行时依赖 0 个 | 新增细节 |
| T12 | 兼容 | 锁定 Pi 1.3.0 事件契约；Node 限 `>=24 <27`；schema 用 `PRAGMA user_version` 管理 | 新增细节 |

一句话：**整套系统只用 Node 自带的东西就能写完**，本机实测的性能余量很大（附录 A）。

---

## 1. T1 应用形态与框架（唯一需要你拍板的一项）

### 1.1 两个方案

| | 方案 A（建议） | 方案 B（PRD 原文） |
|:--|:--|:--|
| 服务端 | `node:http` + 自己写的路由表（约 8 条） | Next.js（App Router，Node Runtime） |
| 前端 | 原生 HTML/CSS/JS，多页面，真实 URL | React 组件 + 客户端渲染 |
| 构建 | 无（Node 直接跑 `.ts`） | `next build` / `next dev` |
| 依赖 | 0 个运行时依赖 | `next` `react` `react-dom` `typescript` 等 |
| 界面来源 | `prototype/` 文件直接变成产品界面 | 原型需要改写为组件 |
| 与项目原则 | 与 D1（选 `node:sqlite` 图零依赖）一致 | 引入框架层 |

### 1.2 建议选 A 的理由

1. **需求已被 Node 内置覆盖**。服务端只需要：静态文件、8 个 JSON 接口、一个 SSE 长连接、一个 SQLite。这四件事 `node:http` / `node:fs` / `node:sqlite` 都能做（SSE 已实测，附录 A.5）。
2. **单用户单机，框架收益最小的场景**。Next.js 的收益主要在路由组织、SSR、多环境部署、团队协作；本项目这些都用不到。
3. **原型不浪费**。原型就是原生 HTML/CSS/JS（`prototype/styles.css`、`app.js` 的标签页/芯片/筛选/树/实时正文已可用）。方案 A 里它们直接成为产品代码，只把 mock 数据换成 `fetch`；方案 B 里同一份设计要重新实现一遍组件，且以后每改一次样式要改两处。
4. **没有构建就没有 "改了没生效" 一类问题**。改完存盘即生效。
5. **供应链风险为 0**，升级路径就是升级 Node。

### 1.3 选 A 要付出的成本与应对

| 损失 | 应对 | 规模 |
|:--|:--|:--|
| 没有组件模型 | 模板函数 + `<template>` + 事件委托，放在 `web/render.ts` | 约 100~200 行 |
| 没有路由框架 | 一张「方法 + 路径正则 → handler」表 | 约 40 行 |
| 没有热更新 | `node --watch src/server.ts`（内置） | 0 |
| 没有 ORM/迁移工具 | `src/schema.sql` + `PRAGMA user_version` 做版本号 | 约 30 行 |
| 类型检查只在编辑器里 | 需要时单独跑 `tsc --noEmit`（不参与运行） | 0 |

### 1.4 什么情况下应该选 B

如果满足任意一条，我建议改回 Next.js：

- 你希望后面加较重的交互（多层筛选、图表联动、虚拟滚动），愿意为此接受框架；
- 你打算把 pi-observer 与 `pi-web` 放在同一套工程习惯里维护；
- 你更希望页面用 React 组件表达（可读性对你更重要，而不是运行时的轻）。

### 1.5 建议的方案 A 目录

```text
pi-observer/
  src/
    server.ts        入口：http server、路由表、优雅退出
    config.ts        配置与默认值（端口、路径、上限）
    db.ts            打开库、PRAGMA、user_version 迁移
    schema.sql       建表与索引
    redact.ts        脱敏黑名单
    ingest.ts        /api/ingest：校验 → 事务 → upsert
    backfill.ts      JSONL 解析、重写检测、对账
    retention.ts     7 天清理 + 空间回收
    sse.ts           订阅表、广播、心跳
    routes/          各读取接口（sessions / tree / turns / requests / health）
    log.ts           单行 JSON 日志
  web/               原型搬过来：index.html session.html … styles.css app.js
  data/              observer.db · token（已在 .gitignore）
  test/              node --test 用例
```

---

## 2. T2 运行时与模块系统

| 项 | 结论 |
|:--|:--|
| 版本 | Node **≥ 24**（PRD §12 定的下限；本机 v26.5.0），`node:sqlite` 无需任何 flag |
| 模块 | ESM（`"type": "module"`），相对导入写全扩展名（含 `.ts`） |
| 打包 | 不打包。Node 直接执行源码 |
| 启动校验 | 启动时检查 `process.versions.node`，不满足直接报错退出并说明原因（PRD §15 已列此风险） |
| 注意 | 官方文档里 `node:sqlite` 至今标注 **Stability 1.2（Release Candidate）**，尚未标 stable。用到的 API（构造类 / `exec` / `prepare` / `run` / `get` / `all`）都是最初就有的那批，但升级 Node 大版本时要跑一遍验收 |

理由：本机只有一份 Node，服务与探针都在同一台机器上，无需考虑多版本兼容。

---

## 3. T3 语言：TypeScript 直接运行

**结论**：用 TypeScript 写，但**不使用 `tsc` 编译**，由 Node 的类型擦除直接运行。

已实测（附录 A.4）：`node app.ts`、`node --test`（跑 `.ts` 用例）、`import "./util.ts"` 均正常。

约束（写代码时必须遵守，属 Node 的 strip-only 模式）：

| 限制 | 说明 | 替代写法 |
|:--|:--|:--|
| 不能写 `enum` | 运行时报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | `const X = {...} as const` + `type X = typeof X[keyof typeof X]` |
| 不能写 `namespace` | 同上 | 普通模块 |
| 构造函数参数属性 | `constructor(private a: string)` 不可用 | 显式赋值 |
| 相对导入要带扩展名 | `import ... from "./db.ts"` | 不能省略 `.ts` |
| 类型不能影响运行 | 装饰器元数据、`emitDecoratorMetadata` 一律不用 | 不用装饰器 |

类型来源：直接 `import type` Pi 的类型声明（`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`），不复制一份，保证与 Pi 版本同步。

探针侧同样是 `.ts`，由 Pi 直接加载（本仓库的 `probes/message-update-rate.ts` 已实测可加载），不需要为扩展单独准备构建产物。

---

## 4. T4 存储：`node:sqlite`

**结论**：用内置 `node:sqlite`，不开额外依赖。理由见 D1：零依赖、无编译、Pi 自己也是这么做的（Pi 1.3.0 的产物里有 `node:sqlite` 的引用，其依赖树里没有任何 SQLite 包）。

实测能力（附录 A.3）：

| 能力 | 结果 |
|:--|:--|
| 版本 | SQLite 3.53.3（随 Node 内置） |
| WAL | `PRAGMA journal_mode = WAL` 生效 |
| 外键 | 默认已开启（`foreign_keys = 1`），不用手动开 |
| 幂等写入 | `INSERT ... ON CONFLICT(...) DO UPDATE` 正常 |
| 命名参数 | `SELECT $n` + 对象传参正常 |
| JSON 函数 | `json_extract` 可用（JSON1 已编入） |
| 迭代器 | `StatementSync.iterate()` 可用 |
| 事务辅助 | **没有** `db.transaction()`，多行写入自己 `BEGIN IMMEDIATE` / `COMMIT` |
| 大整数 | 超过 2^53 会抛 `ERR_OUT_OF_RANGE`，需要 `readBigInts` / `setReadBigInts`。本项目的 token / 字节数远低于该上限 |
| 类名 | **本机 26.5.0 只导出 `DatabaseSync`**（没有 `Database`）。上游文档（v26.12.0）已改名为 `Database`，`DatabaseSync` 变成废弃别名 → 代码里统一用 `const Db = DatabaseSync` 这类局部别名，将来改名只动一行 |
| 忙等待 | 用构造参数 `new DatabaseSync(path, { timeout: 5000 })` 代替手写 `PRAGMA busy_timeout`（实测生效） |
| 其他可用 | `db.isOpen`、`db.isTransaction`、`PRAGMA user_version` 读写（用于 schema 版本管理）均实测可用 |

性能实测（附录 A.3）：

| 操作 | 实测 |
|:--|:--|
| 12,000 次 upsert（单事务） | 39 ms（≈ 31 万行/秒） |
| 20,000 条事件插入（单事务） | 32 ms |
| 删除 20,000 行 | 8 ms |
| 命中索引的列表查询（取 50 行） | 0.023 ms/次 |
| **未命中索引**的 `ORDER BY ... LIMIT 50`（1 万行） | **6.4 ms/次**（慢 280 倍） |
| 按唯一键取单条 | 0.003 ms/次 |

**结论性细节**：索引不是可选项，PRD §8.5 列的索引必须建（列表页每次刷新都会跑排序查询）。

不选的其他方案：

| 方案 | 不选的理由 |
|:--|:--|
| better-sqlite3 | 原生模块，需编译与 ABI 对齐（本机有 Xcode/clang 能编，但没有必要引入） |
| sql.js（WASM） | 全内存，持久化要自己做，写入语义与崩溃安全都要自己兜 |
| Prisma / Drizzle | 代码生成 + 迁移工具链，对 7 张表不值当；查询也不复杂 |
| DuckDB | 分析型；本项目是行级 upsert + 高频小读，用不上列存 |

---

## 5. T5 接口与实时传输

**结论**：探针 → 服务用 HTTP 批量 POST；服务 → 浏览器用 SSE。

| 环节 | 选择 | 理由 |
|:--|:--|:--|
| 探针推送 | `POST /api/ingest`，批量 50 条 / 300 ms | PRD §7.5；断线只丢队列不阻塞 Pi |
| 鉴权 | `x-observer-token`，与 `data/token` 用 `crypto.timingSafeEqual` 比对 | 内置模块；避免时序泄漏 |
| 服务 → 浏览器 | **SSE**（`text/event-stream`） | 只需单向推送；浏览器原生 `EventSource` 自带断线重连；零依赖 |
| 不用 WebSocket | — | 双向能力用不上，还要自己写重连与心跳 |
| 事件载荷 | 只带标识与版本号，页面按需二次拉取 | PRD §10 已有约定，避免大对象进推送通道 |

SSE 实现要点（已实测帧格式正确，附录 A.5）：

- 响应头：`content-type: text/event-stream`、`cache-control: no-cache`、`connection: keep-alive`、`x-accel-buffering: no`；
- 每 20~30 秒发一次注释心跳（`: ping`），防止中间层与长连接回收；
- `res.on("close")` 里从订阅表移除，避免泄漏；
- 广播只写内存订阅表，不查库。

---

## 6. T6 前端渲染

**结论**：原生 HTML/CSS/JS 多页面；样式直接复用原型；局部更新只重绘受影响的容器。

| 项 | 做法 |
|:--|:--|
| 样式 | `prototype/styles.css` → `web/styles.css`，tokens 仍在 `:root` 一处 |
| 页面 | 多页面真实 URL（列表 / 会话 / 请求 / 工具 / JSONL / 探针），不用单页路由 |
| 数据 | `fetch` 拉 JSON，`EventSource` 订阅 SSE |
| 渲染 | 字符串模板函数（统一转义）+ `<template>` + 事件委托 |
| 复用 | 原型 `app.js` 的标签页、开关芯片、筛选、树折叠、实时正文逻辑直接留用 |
| 不做 | React/Vue/Svelte、虚拟 DOM、客户端路由库、CSS 框架 |

选择多页面的理由：会话 / 请求 / 工具本身就是层级关系，真实 URL 可以被收藏、刷新、直接打开；单页路由在这个规模上只增加状态管理成本。

---

## 7. T7 输入校验与配置

| 项 | 结论 | 理由 |
|:--|:--|:--|
| 请求校验 | 每个接口一个手写 `parseXxx()`，返回 `{ ok: true, value }` 或 `{ ok: false, error }` | 接口 8 个、字段固定；引入 zod/ajv 会带来依赖和最小化问题 |
| 大小限制 | 在读取请求体时按字节截断（默认 2 MB 批次上限） | 防止畸形请求打满内存 |
| 配置来源 | `process.env` + `src/config.ts` 里的默认值 | 不引 dotenv；配置项本来就只有十来个 |
| 令牌 | `data/token`（首次启动生成，权限 0600） | PRD §12 |

---

## 8. T8 测试

| 项 | 结论 |
|:--|:--|
| 运行器 | `node --test`（内置），断言用 `node:assert/strict` |
| 文件 | `test/*.test.ts`，无需配置 |
| 已实测 | `node --test` 能直接跑 `.ts` 用例并通过（附录 A.4） |
| 优先覆盖 | JSONL 5 条解析规则、幂等 upsert（同一 payload 写两次只有一行）、脱敏黑名单、7 天清理、SSE 帧格式、队列溢出与 `dropped_count` |
| 不引 | vitest / jest（都要转译或构建配置，收益为 0） |

---

## 9. T9 日志

**结论**：单行 JSON 写 stderr；保留最近 N 条（N=200）在内存里，供探针状态页展示；不引 pino / winston。

字段固定：`{ ts, level, scope, msg, ...extra }`。探针侧同一格式，但**只记录不抛出**（PRD §1.4 第 5 条）。

---

## 10. T10 运行方式

| 项 | 值 |
|:--|:--|
| 启动 | `node src/server.ts` |
| 开发 | `node --watch src/server.ts` |
| 监听 | `127.0.0.1:4173`（启动时校验，禁止 `0.0.0.0`） |
| 数据目录 | `./data/`（`observer.db`、`token`），与代码分离，已被 `.gitignore` |
| 探针加载 | `pi --extension /absolute/path/to/pi-observer/ext` |
| 开机自启 | 默认不装；需要时给一份 `launchd` plist 模板（可选） |
| 优雅退出 | `SIGINT` / `SIGTERM` 时关 SSE、`wal_checkpoint(TRUNCATE)`、关库 |

注意：PRD §12 写的 `npm run dev` / `npm run start` 是 Next.js 习惯；选 A 后这两个脚本只是别名（`dev: node --watch ...`、`start: node ...`），语义不变。

---

## 11. T11 依赖清单

| 类别 | 方案 A | 方案 B |
|:--|:--|:--|
| 运行时依赖 | **无** | `next` `react` `react-dom` |
| 开发依赖 | 无（`tsc` 可选） | `typescript` `@types/node` `@types/react` |
| 类型来源 | `import type` Pi 的 `.d.ts` | 同 |

网络可达（本机实测 npm registry 返回 200，0.83 s），所以「要不要装依赖」是取舍问题，不是可行性问题。

---

## 12. T12 版本与兼容策略

| 项 | 策略 |
|:--|:--|
| Node | 锁 `>=24 <27`；启动时校验并给出可执行提示 |
| SQLite | 不单独校验版本，跟随 Node；schema 全用通用语法 |
| Node 小版本 | 纳入观察：`node:sqlite` 在 26.x 内部就发生过改名（26.5.0 只有 `DatabaseSync`，26.12.0 文档已是 `Database`），所以代码里的类名要收口到一个别名 |
| schema 变更 | `PRAGMA user_version` 递增 + 启动时幂等迁移；只做加列/加表，不做破坏性变更 |
| Pi | 记录适配版本 1.3.0；Pi 升级后跑一遍 M1 验收（PRD §14） |
| 浏览器 | 现代 Chrome / Safari；已用到 `backdrop-filter`、`<details>`、`EventSource`，均为长期稳定特性 |

---

## 13. 明确排除（不作为技术方案）

与 PRD §4.6 对齐，这些不是「以后再考虑」，而是**确定不用**：

| 排除项 | 原因 |
|:--|:--|
| Pi 遥测 | 本机不可用 |
| Durable 运行时 | 本机 Pi 1.3.0 不存在（D6） |
| RPC 通道（`get_entries` 等） | 需要一个额外的客户端进程；JSONL 直读已覆盖同一份数据 |
| 第三方看板应用（含已卸载的 pi-dashboard）的接口与文件 | D3：完全独立 |
| 会话旁 `*.meta.json` | 已卸载应用写的残留，不是 Pi 的数据 |
| 任何写 Pi 的 API（`appendEntry` / `sendMessage` / `setActiveTools` …） | 只读原则（PRD §1.4） |
| `before_provider_headers` / `tool_call` / `context` / `provider_stream_event` 订阅 | 拦截点或高开销点（PRD §5.1） |
| 文件监听（`fs.watch`） | 不需要：回填由「启动扫描 + 进页面补读 + `agent_settled` 后对账」触发（PRD §9.1、§9.3） |

---

## 14. 需要同步进 PRD 的 3 处

| 处 | 现状 | 建议 |
|:--|:--|:--|
| 文档头「技术栈」行 + §6 架构图 + §12 启动方式 | 写的是 Next.js | 若确认 T1 走方案 A，改成 `node:http` + 原生前端 + `node src/server.ts` |
| §8.6 保留与清理 | 只写「每天一次 VACUUM」 | 补一句：**VACUUM 之后必须跟一次 `PRAGMA wal_checkpoint(TRUNCATE)`**，否则磁盘空间不释放（实测见附录 A.6） |
| §8.1 驱动 | 未写初始化顺序 | 补：`journal_mode=WAL`；若要用 `auto_vacuum`，必须在建表前设置（顺序错则需先 `VACUUM` 才生效，实测见附录 A.6） |

---

## 附录 A 本机实测记录（本次，2026-10-19）

环境：macOS 27.0.1 / Apple M1 Pro / arm64 / Node v26.5.0 / npm 11.17.0 / pnpm 11.16.0；磁盘可用 120 GiB；Xcode 工具链与 python3 均在（原生模块可编，但方案不需要）。SQLite 相关实测跑在 26.5.0 的 `DatabaseSync` 上（本机导出名，见 A.3）。

### A.1 会话数据现状

- `~/.pi/agent/sessions/` 下 3 个会话文件，合计 0.1 MB，最大 20 行、每行均长约 3.8 KB。
- 条目类型实测分布（最大文件）：`message` 17、`session` 1、`model_change` 1、`thinking_level_change` 1。
- 结论：当前真实规模极小；性能设计按「会长大」来做。

### A.2 JSONL 全量解析能力（合成大文件）

构造 38.5 MB / 12,001 行的会话文件：

| 指标 | 实测 |
|:--|:--|
| 读取（utf8 全量） | 38.7 ms（≈ 993 MB/s） |
| 逐行 `JSON.parse` 并处理 | 34.6 ms（≈ 1,110 MB/s） |
| 堆占用 | 52 MB |

结论：**全量读入 + 逐行解析**足够，不需要流式解析器；但必须逐条处理不保留对象（否则内存按倍数增长）。阈值建议：单文件超过 512 MB 时再考虑流式。

### A.3 `node:sqlite` 能力与性能

能力：见 §4 表（WAL 生效、外键默认开、JSON1 可用、无 `db.transaction()`、大整数需 `readBigInts`）。

导出名实测：`node:sqlite` 在 26.5.0 只导出 `DatabaseSync` / `Session` / `StatementSync` / `backup` / `constants` / `default`；`Database` 这个名字在 v26.12.0 的文档里才有（改名发生在 26.x 的小版本里）。

性能（12,000 行、每行 200 B payload；20,000 条事件）：

| 操作 | 实测 |
|:--|:--|
| 12,000 upsert（单事务） | 39 ms |
| 20,000 事件插入（单事务） | 32 ms |
| 删除 20,000 行（按时间条件） | 8 ms |
| 列表查询 ×1000（命中索引） | 23 ms 合计 |
| 列表查询 ×1000（**无索引**） | 6,419 ms 合计 |
| 单条查询 ×1000 | 3 ms 合计 |
| 库文件体积 | 4.7 MB（含 WAL 4.8 MB） |

### A.4 TypeScript 直接运行

| 检查 | 结果 |
|:--|:--|
| `node app.ts`（interface / 泛型 / `as const` / 可选链） | 通过 |
| `node --test` 跑 `.ts` 用例 | 2 个用例通过，91 ms |
| `import ... from "./util.ts"` | 通过 |
| `enum E { A }` | 失败：`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript enum is not supported in strip-only mode` |

### A.5 SSE

`node:http` 写 `event:` / `data:` / 空行，`curl -N` 实时收到 3 帧；无缓冲问题。

### A.6 空间回收（重要）

WAL 模式下，20,400 行 / 155 MB 的库（20,000 条事件 + 400 条请求 payload）：

| 步骤 | 主库 | WAL |
|:--|:--|:--|
| 清理前 | 155.2 MB | — |
| 删除 20,000 行 + 清空 payload（51 ms） | 155.2 MB | — |
| `VACUUM`（0.5 ms） | **155.2 MB（没变）** | 79.1 MB |
| `PRAGMA wal_checkpoint(TRUNCATE)`（10 ms） | **0 MB** | **0 MB** |

结论：**只 `VACUUM` 不 checkpoint，磁盘不会释放**，回收总量 155 MB。

增量方案（初始化顺序正确时可用）：`PRAGMA auto_vacuum = INCREMENTAL` → `journal_mode=WAL` → 建表；插入 79.3 MB → 删除 20,000 行（41 ms）→ `PRAGMA incremental_vacuum` + checkpoint（268 ms）→ **0 MB**。

顺序错误的后果（实测）：先设 `journal_mode=WAL` 再设 `auto_vacuum`，读回仍是 `0`（未生效），必须补一次 `VACUUM` 才生效。

按附录 B 的完整顺序端到端实测一次（78.4 MB 库：20,000 条事件 + 200 条 200 KB 的请求 payload）：

| 步骤 | 结果 |
|:--|:--|
| `BEGIN IMMEDIATE` → 删过期事件 → 清空 payload → `COMMIT` → `VACUUM` → `wal_checkpoint(TRUNCATE)` | 全部 45.7 ms |
| 库文件 | 78.4 MB → 0 MB |
| 剩余事件行 | 0 |
| 保留的请求行 | 200（payload 变为 `{"deleted":true}`，统计字段保留） |
| `PRAGMA user_version` | 可读写（0 → 1），可用于 schema 版本管理 |

---

## 附录 B 初始化与清理的正确顺序

```ts
// 打开库（首次运行）
// 本机 26.5.0 导出的名字是 DatabaseSync；上游新版已改名 Database，故留一个别名收口
import { DatabaseSync as Db } from "node:sqlite";

const db = new Db("data/observer.db", { timeout: 5000 }); // 内置 busy_timeout
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");   // WAL 下的常规选择
// 若要用增量回收，必须在建表前设置：
// db.exec("PRAGMA auto_vacuum = INCREMENTAL");
db.exec(readFileSync("src/schema.sql", "utf8"));
// 迁移：PRAGMA user_version（实测可读写，本例 0 → 1）

// 每天一次的空间回收（PRD §8.6）
db.exec("BEGIN IMMEDIATE");
db.prepare("DELETE FROM events WHERE received_at < ?").run(cutoffIso);
db.prepare("UPDATE llm_requests SET payload = '{\"deleted\":true}', response_headers = '{\"deleted\":true}' WHERE created_at < ?").run(cutoffIso);
db.exec("COMMIT");
db.exec("VACUUM");                                   // 不能在事务里跑
db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); // 关键：没有这一步，磁盘不释放
```
