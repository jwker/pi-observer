# pi-observer 技术选型

| 项 | 内容 |
|:--|:--|
| 版本 | v2（2026-10-19） |
| 适用 | pi-observer PRD v0.2 |
| 依据 | 本机实测（macOS 27.0.1 / Apple M1 Pro / Node v26.5.0），见附录 A / C；Next.js 官方文档与 npm registry（2026-10-19） |
| 状态 | **T1 已确认：方案 B（Next.js）**，其余为结论 |
| 原则 | 单用户、单机、只读、回环访问；服务端能力尽量用 Node 内置，框架只负责页面、路由与构建 |

---

## 0. 结论速览

| 编号 | 项目 | 结论 | 是否偏离 PRD v0.2 |
|:--|:--|:--|:--|
| T1 | 应用形态 | **Next.js 16.4.2**（App Router + React 19 + Node Runtime）。原型是设计产物，不作为产品代码 | 一致（PRD 原文） |
| T2 | 运行时 | Node ≥ 24（本机 26.5.0）；Next 自身要求 ≥ 20.9.0；ESM；构建用 Turbopack（Next 16 默认） | 一致 |
| T3 | 语言 | TypeScript 由 Next 构建；**应用代码不受 Node strip-only 限制**。探针目录例外，见 §3 | 一致（更宽松） |
| T4 | 存储 | `node:sqlite`（内置 SQLite 3.53.3），只在服务端引用；连接挂 `globalThis` 单例 | 一致（D1 / C3） |
| T5 | 接口与实时 | Route Handler（`runtime = "nodejs"`）：`POST /api/ingest` 批量 + 令牌；服务 → 浏览器用 SSE | 一致（PRD §10） |
| T6 | 前端 | React 组件 + App Router 真实 URL；界面按原型的设计规范重写，不复制原型代码 | 一致 |
| T7 | 校验与配置 | 手写校验函数；`process.env` + 默认值；不引 zod / dotenv | 新增细节 |
| T8 | 测试 | `node --test` 跑纯逻辑（`src/lib/**`）；组件测试按需再加 | 新增细节 |
| T9 | 日志 | 单行 JSON 写 stderr，不引日志库 | 新增细节 |
| T10 | 运行 | `next dev` / `next start`，**必须显式 `-H 127.0.0.1 -p 4173`**（默认是 `0.0.0.0`） | 细节化 PRD §12 |
| T11 | 依赖 | 运行时 3 个：`next` `react` `react-dom`；开发依赖 `typescript` 与类型包 | 新增细节 |
| T12 | 兼容 | Node 锁 `>=24 <27`；Next 锁 `16.4.x`；适配 Pi 1.3.0；schema 用 `PRAGMA user_version` | 新增细节 |

一句话：**框架只承担页面、路由与构建；数据、解析、清理、推送仍全部由 Node 内置能力完成**，所以下面 T4～T9 的结论与「不用框架」时基本相同。

---

## 1. T1 应用形态与框架（已确认）

### 1.1 结论

| 项 | 选择 |
|:--|:--|
| 框架 | Next.js 16.4.2，App Router |
| UI | React 19.3.1（`react` + `react-dom`） |
| 服务端 | Route Handler，`runtime = "nodejs"`，不使用 Edge Runtime |
| 路由 | 真实 URL 多页面（`/`、`/sessions/[id]`、`/probe`、各 `/api/*`） |
| 构建 | Turbopack（Next 16 的 `dev` 与 `build` 默认值，无需 `--turbopack`） |
| 原型定位 | **设计产物**：提供视觉规范、信息结构与交互约定；产品代码按 React 组件重写 |

### 1.2 选 B 的理由（记录决策依据）

1. **原型是设计产物，不作为开发产品**。方案 A 的最大卖点是「原型 HTML 直接变成产品界面」，这条不成立，方案 A 因此失去主要优势。
2. **界面交互会变重**。会话详情本身就有多层筛选、可折叠消息树、标签页、实时正文、详情抽屉；用组件表达比模板函数更省心。
3. **与 PRD 原文一致**，文档与实现不再有两套说法，也不需要为 T1 维护一段「偏离说明」。
4. 本机网络与工具链完备（npm registry 可达，实测见附录 C），装依赖是取舍问题，不是可行性问题。

### 1.3 方案 A（`node:http` + 原生前端）落选记录

保留在此，防止以后重复讨论：

| 方案 A 的主张 | 实际结论 |
|:--|:--|
| 原型文件直接成为产品代码 | 不成立。原型是设计产物，不作为产品代码；同一份设计无论选哪个方案都要重写一次 |
| 零依赖、无构建 | 成立，但换来的是自己维护路由表、模板函数、静态资源服务（约 200~300 行） |
| `node:sqlite` 只能配方案 A | 不成立，已实测在 Next Route Handler 中可用（附录 C.1） |
| SSE 在框架里会被缓冲 | 不成立，已实测 `next dev` 与 `next start` 都逐帧即时刷新（附录 C.3） |

结论：方案 A 的唯一实质收益是省掉 `next` `react` `react-dom` 三个依赖与其构建步骤，代价是自己维护一套小框架；在你已经选定 React 组件方向后，这个代价不再值得。

### 1.4 目录结构

```text
pi-observer/
  src/
    app/                        路由与页面（App Router）
      layout.tsx
      page.tsx                  会话列表（PRD §11.1）
      sessions/[id]/page.tsx    会话详情：树 + 时间线 / 请求 / 工具（§11.2）
      probe/page.tsx            探针状态（§11.3）
      api/
        ingest/route.ts         POST 批量接收（令牌）
        stream/route.ts         GET  SSE
        sessions/route.ts       读取接口
        ...
    components/                 界面组件（视觉按原型）
    lib/                        纯逻辑，不依赖 Next（可被 node --test 直接跑）
      config.ts                 配置与默认值
      db.ts                     打开库、PRAGMA、user_version 迁移（server-only）
      schema.ts                 建表与索引（内联 DDL，不用 .sql 文件）
      redact.ts                 脱敏黑名单
      ingest.ts                 校验 → 事务 → upsert
      backfill.ts               JSONL 解析、重写检测、回填入库、对账
      tree.ts                   消息树的父子结构、当前分支、过滤、图标（纯函数）
      retention.ts              7 天清理 + 空间回收
      sse.ts                    订阅表与广播
      log.ts                    单行 JSON 日志
  ext/
    index.ts                    探针入口（Pi 直接加载，不参与 Next 构建）
  probes/                       一次性测量脚本（已验证的测量代码）
  test/                         node --test 用例
  public/                       静态资源
  data/                         observer.db · token（已在 .gitignore）
  next.config.ts                含 agentRules: false（不让 Next 生成 AGENTS.md）
  tsconfig.json / package.json
```

两条硬约定：

- `src/lib/**` 只用相对导入，且**相对导入必须带 `.ts` 后缀**（原因见 §3.2、§8）；
- `src/app/**` 只做「取参数 → 调 `src/lib` → 返回 Response / 渲染组件」，不写业务逻辑。

---

## 2. T2 运行时与模块系统

| 项 | 结论 |
|:--|:--|
| Node | **≥ 24**（PRD §12 定的下限；本机 v26.5.0）。Next 16.4.2 自己要求 `>=20.9.0`，不构成约束；`node:sqlite` 才是下限来源 |
| 模块 | ESM（`"type": "module"`），由 Next 打包；`src/lib` 的相对导入带 `.ts` 后缀 |
| 打包 | Turbopack（Next 16 默认）。不需要额外的打包器配置 |
| 类型门禁 | `next build` 会先跑 TypeScript 检查；也可单独 `next typegen && tsc --noEmit` |
| 启动校验 | 启动时检查 `process.versions.node`，不满足直接报错退出并说明原因（PRD §15 已列此风险） |
| 注意 | `node:sqlite` 官方文档至今标注 **Stability 1.2（Release Candidate）**。用到的 API（构造类 / `exec` / `prepare` / `run` / `get` / `all`）都是最初那批，但升级 Node 大版本时要跑一遍验收 |

---

## 3. T3 语言与 TypeScript

### 3.1 应用代码：由 Next 构建，不受 strip-only 限制

`next build` / `next dev` 用 Turbopack 转译 TS，因此 `enum`、`namespace`、构造函数参数属性、省略扩展名的相对导入等写法**在应用代码里都能用**。已实测（附录 C.2）：构建通过、`tsc --noEmit` 通过。

`tsconfig.json` 关键项：

| 项 | 值 | 说明 |
|:--|:--|:--|
| `allowImportingTsExtensions` | `true` | 允许 `import { x } from "./x.ts"`；Next 默认 `noEmit: true`，无冲突。Next 会自动把 `jsx` 改成 `react-jsx` 并补 `include`，**不会**动这一项 |
| `paths` | `"@/*": ["./src/*"]` | 组件层用别名导入（`@/lib/...`）更易读；**但 `src/lib` 内部不要用别名**，否则 `node --test` 解析不到 |
| `strict` | `true` | — |

### 3.2 为什么仍要求 `src/lib` 的相对导入带 `.ts`

`test/*.test.ts` 要用 `node --test` 直接跑（不引入第二套测试工具链），而被测模块在 Node 下解析的是**真实文件路径**：

| 写法 | `node a.ts` 结果 |
|:--|:--|
| `import { v } from "./b.ts"` | 通过（实测） |
| `import { v } from "./b"` | 失败：`ERR_MODULE_NOT_FOUND`（实测） |
| `import { v } from "@/lib/b"` | 失败：Node 不认识 `paths` 别名 |

已实测：`.ts` 后缀的相对导入在 Next 的构建与运行期都正常（附录 C.2），所以这条约定两边都满足，不需要妥协。

### 3.3 类型来源

直接 `import type` Pi 的类型声明（`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`），不复制一份，保证与 Pi 版本同步。

### 3.4 探针侧（`ext/`）：由 Pi 加载，独立于 Next

- Pi 用 **jiti** 加载扩展（`dist/core/extensions/loader.js`），会做转译，所以严格来说不受 strip-only 限制；`--extension` 指向目录里的 `index.ts` 也受支持（已从源码确认）。
- 但探针里仍**建议不用 `enum` / `namespace`**，因为探针的纯逻辑（队列、合并、脱敏）最容易也最值得用 `node --test` 直接测，而 Node 直跑时 strip-only 限制是真实存在的。
- 探针不进入 Next 的构建范围，`ext/` 不是 `src/` 下的内容。

---

## 4. T4 存储：`node:sqlite`

**结论**：用内置 `node:sqlite`，不引额外依赖（D1：零依赖、无编译，Pi 自己也是这么做的）。

### 4.1 Next 环境下的三条要求

1. **只在服务端引用**。`src/lib/db.ts` 只被 route handler / server 组件引用；不得出现在任何客户端组件里。建议加一行 `import "server-only"` 把误引用变成构建期报错（`server-only` 是 React 官方提供的极小包；不装也可以，靠目录约定保证）。
2. **连接挂 `globalThis` 单例**（PRD §8.4）。开发态热重载会重新执行模块，不缓存就会出现多个连接。已实测（附录 C.4）：改文件触发 HMR 后仍是同一个连接，写入连续、无 `database is locked`。
3. **不进 Edge Runtime**。route handler 里显式 `export const runtime = "nodejs"`；需要实时读库的接口再加 `export const dynamic = "force-dynamic"`，避免构建期被预渲染。

### 4.2 实测能力（附录 A.3）

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
| 其他可用 | `db.isOpen`、`db.isTransaction`、`PRAGMA user_version` 读写均实测可用 |

### 4.3 性能实测（附录 A.3）

| 操作 | 实测 |
|:--|:--|
| 12,000 次 upsert（单事务） | 39 ms（≈ 31 万行/秒） |
| 20,000 条事件插入（单事务） | 32 ms |
| 删除 20,000 行 | 8 ms |
| 命中索引的列表查询（取 50 行） | 0.023 ms/次 |
| **未命中索引**的 `ORDER BY ... LIMIT 50`（1 万行） | **6.4 ms/次**（慢 280 倍） |
| 按唯一键取单条 | 0.003 ms/次 |

**结论**：索引不是可选项，PRD §8.5 列的索引必须建（列表页每次刷新都会跑排序查询）。

### 4.4 不选的其他方案

| 方案 | 不选的理由 |
|:--|:--|
| better-sqlite3 | 原生模块，需编译与 ABI 对齐（本机有 Xcode 能编，但没有必要引入） |
| sql.js（WASM） | 全内存，持久化要自己做，写入语义与崩溃安全都要自己兜 |
| Prisma / Drizzle | 代码生成 + 迁移工具链，对 7 张表不值当；查询也不复杂 |
| DuckDB | 分析型；本项目是行级 upsert + 高频小读，用不上列存 |

---

## 5. T5 接口与实时传输

**结论**：探针 → 服务用 HTTP 批量 POST（Route Handler）；服务 → 浏览器用 SSE。

| 环节 | 选择 | 理由 |
|:--|:--|:--|
| 探针推送 | `POST /api/ingest`，批量 50 条 / 300 ms | PRD §7.5；断线只丢队列不阻塞 Pi |
| 鉴权 | `x-observer-token`，与 `data/token` 用 `crypto.timingSafeEqual` 比对 | 内置模块；避免时序泄漏 |
| 服务 → 浏览器 | **SSE**（`text/event-stream`），route handler 返回 `ReadableStream` | 只需单向推送；浏览器原生 `EventSource` 自带断线重连 |
| 不用 WebSocket | — | 双向能力用不上，还要自己写重连与心跳 |
| 事件载荷 | 只带标识与版本号，页面按需二次拉取 | PRD §10 已有约定，避免大对象进推送通道 |

SSE 实现要点（已实测，附录 C.3）：

- route handler 固定加 `export const runtime = "nodejs"` 与 `export const dynamic = "force-dynamic"`；
- 响应头：`content-type: text/event-stream; charset=utf-8`、`cache-control: no-cache, no-transform`、`x-accel-buffering: no`；
- 每 20~30 秒发一次注释心跳（`: ping`），防止长连接被回收；
- `req.signal` 的 `abort` 事件里从订阅表移除，避免泄漏；
- 广播只写内存订阅表，不查库。

请求体上限：App Router 的 route handler **没有默认体积上限**（实测 5 MB 直接通过，附录 C.5），所以 2 MB 批次上限由我们自己的校验函数执行（T7），不能依赖框架兜底。

---

## 6. T6 前端渲染

**结论**：React 组件 + App Router 真实 URL；界面按原型的设计规范重写。

| 项 | 做法 |
|:--|:--|
| 设计来源 | `prototype/`（设计产物）：色板、字号、间距、状态色语义、页面清单与信息结构 |
| 样式落地 | 把 `prototype/styles.css` 顶部的 `:root` tokens 原值搬到 `src/app/globals.css`，作为唯一来源；组件样式沿用原型的类命名习惯 |
| 页面 | 多路由真实 URL（列表 / 会话 / 请求 / 工具 / JSONL / 探针），可收藏、可刷新、可直接打开 |
| 数据 | 列表与详情用服务端取数（server component 直读 `src/lib`）；实时部分用客户端组件 + `EventSource` |
| 新写 | 原型的 `app.js` 交互（标签页、开关芯片、筛选、树折叠、实时正文）重写为 React 状态与事件，**不复制粘贴** |
| 不做 | SPA 式客户端路由、CSS 框架、UI 组件库、图表库 |

选择真实 URL 的理由：会话 / 请求 / 工具本身就是层级关系，URL 可以直接分享与收藏；SPA 路由在这个规模上只增加状态管理成本。

原型与产品的关系，一句话：**设计值照搬，代码重写**。改配色或宽度只需改 `prototype/styles.css` 的 `:root` 与 `--page-max` 并同步到 `globals.css`。

---

## 7. T7 输入校验与配置

| 项 | 结论 | 理由 |
|:--|:--|:--|
| 请求校验 | 每个接口一个手写 `parseXxx()`，返回 `{ ok: true, value }` 或 `{ ok: false, error }` | 接口约 8 个、字段固定；本轮不引入 zod。若后续校验分支明显变多，再加也不影响架构 |
| 大小限制 | 读取请求体时按字节截断（默认 2 MB 批次上限） | 框架不兜底（附录 C.5），必须自己限 |
| 配置来源 | `process.env` + `src/lib/config.ts` 里的默认值 | 不引 dotenv；配置项本来就只有十来个 |
| 令牌 | `data/token`（首次启动生成，权限 0600） | PRD §12 |

不要把配置写进 `.env` 的两个特例：`PORT` 对 Next 无效（启动 HTTP 服务器的时机早于 `.env` 加载），端口只从命令行 `-p` 传。

---

## 8. T8 测试

| 项 | 结论 |
|:--|:--|
| 运行器 | `node --test`（内置），断言用 `node:assert/strict` |
| 文件 | `test/*.test.ts`，无需配置（已实测能直接跑 `.ts`，附录 A.4） |
| 前提 | 被测模块放在 `src/lib/**`，且相对导入带 `.ts` 后缀（§3.2） |
| 优先覆盖 | JSONL 5 条解析规则、幂等 upsert（同一 payload 写两次只有一行）、脱敏黑名单、7 天清理、SSE 帧格式、探针队列溢出与 `dropped_count` |
| 类型检查 | `next typegen && tsc --noEmit`（框架自带，不额外引工具） |
| 覆盖率 | `npm run coverage`（`node --test --experimental-test-coverage`，内置，不引依赖）。只统计被测试 import 的模块，`src/app/**` 与 `src/components/**` 不计入 |
| 一次跑完 | `npm run check` = 单测 + 类型检查 + 构建 |
| 端到端 | `npm run accept`：档 A 离线验收，13 项断言，跑在临时数据目录与空闲端口上，无副作用。`npm run verify` = `check` + `accept` |
| 真实 Pi | `tools/acceptance/real-pi/`：卡顿 A/B、强杀恢复、HMR、端到端延迟。会花 token 或杀端口，详见该目录 README |
| 不引 | vitest / jest。若将来真要为 React 组件写断言，再加 vitest，到那时再说 |

---

## 9. T9 日志

**结论**：单行 JSON 写 stderr；保留最近 N 条（N=200）在内存里，供探针状态页展示；不引 pino / winston。

字段固定：`{ ts, level, scope, msg, ...extra }`。探针侧同一格式，但**只记录不抛出**（PRD §1.4 第 5 条）。

---

## 10. T10 运行方式

| 项 | 值 |
|:--|:--|
| 开发 | `next dev -H 127.0.0.1 -p 4173` |
| 生产 | `next build && next start -H 127.0.0.1 -p 4173` |
| 监听 | 必须显式 `-H 127.0.0.1`（**Next 的 `dev` 与 `start` 默认都是 `0.0.0.0`**，官方 CLI 文档确认；已实测显式指定后只监听回环，附录 C.6） |
| 数据目录 | `./data/`（`observer.db`、`token`），与代码分离，已被 `.gitignore` |
| 探针加载 | `pi --extension /absolute/path/to/pi-observer/ext`（目录内 `index.ts` 为入口，已从 Pi 源码确认支持） |
| 开机自启 | 默认不装；需要时给一份 `launchd` plist 模板（可选） |
| 优雅退出 | `SIGINT` / `SIGTERM` 时关 SSE、`wal_checkpoint(TRUNCATE)`、关库 |

`package.json` 脚本（flags 写在脚本里，不用 `npm run dev -- -p ...`）：

```json
{
  "scripts": {
    "dev": "next dev -H 127.0.0.1 -p 4173",
    "build": "next build",
    "start": "next start -H 127.0.0.1 -p 4173",
    "typecheck": "next typegen && tsc --noEmit",
    "test": "node --test test/"
  }
}
```

两个 Next 16 的附带行为，开工时要注意：

- `next dev` 会在项目根目录**自动生成 `AGENTS.md`**（Next 自己的 agent 规则文件）。本仓库已有 `AGENT.md`，两份容易混，建议在 `next.config.ts` 里设 `agentRules: false` 关掉。
- 开发构建输出在 `.next/dev`，与 `next build` 的 `.next` 分开，两者可同时跑。`.next/` 已在 `.gitignore`。

---

## 11. T11 依赖清单

| 类别 | 包 |
|:--|:--|
| 运行时依赖 | `next@16.4.2`、`react@19.3.1`、`react-dom@19.3.1` |
| 开发依赖 | `typescript`、`@types/node`、`@types/react`、`@types/react-dom` |
| 可选 | `server-only`（把「客户端误引用服务端模块」变成构建期错误） |
| 不引 | ORM、校验库、日志库、测试框架、CSS 框架、UI 组件库 |

实测：`npm install next@16 react react-dom` 与开发依赖全部装完约 3 分钟（本机网络条件，附录 C.0）。

---

## 12. T12 版本与兼容策略

| 项 | 策略 |
|:--|:--|
| Node | 锁 `>=24 <27`；启动时校验并给出可执行提示 |
| Next | 锁 `16.4.x`（精确到小版本）。Next 大版本会改默认行为，例如默认监听地址与构建器；升级前跑一遍 M1 验收 |
| React | 跟随 Next 16 的 peer 要求（当前 19.x） |
| SQLite | 不单独校验版本，跟随 Node；schema 全用通用语法 |
| Node 小版本 | 纳入观察：`node:sqlite` 在 26.x 内部就发生过改名（26.5.0 只有 `DatabaseSync`，26.12.0 文档已是 `Database`），所以类名要收口到一个别名 |
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
| 第三方看板应用（含已卸载的那些）的接口与文件 | D3：完全独立，不共用接口、不共用文件 |
| 会话旁 `*.meta.json` | 已卸载应用写的残留，不是 Pi 的数据 |
| 任何写 Pi 的 API（`appendEntry` / `sendMessage` / `setActiveTools` …） | 只读原则（PRD §1.4） |
| `before_provider_headers` / `tool_call` / `context` / `provider_stream_event` 订阅 | 拦截点或高开销点（PRD §5.1） |
| 文件监听（`fs.watch`） | 不需要：回填由「启动扫描 + 进页面补读 + `agent_settled` 后对账」触发（PRD §9.1、§9.3） |
| Edge Runtime | 用不了 `node:sqlite` 与 `node:fs` |
| 把原型代码当作产品代码 | 原型是设计产物；产品界面按 §6 重写 |
| 用 Next 的 Server Action / 表单提交做写操作 | 看板只读，没有任何写入口 |

---

## 14. M1 开工第一天先做的验证

以下 6 项已在本次评估中用临时工程跑通（细节见附录 C），列在这里是为了 M1 复制到本仓库后再跑一遍确认环境一致：

| # | 验证 | 通过判据 | 本次实测 |
|:--|:--|:--|:--|
| 1 | route handler 里 `import { DatabaseSync } from "node:sqlite"` | 能建库、能写、返回 SQLite 版本 | 通过 |
| 2 | `src/lib` 用 `.ts` 后缀相对导入，被 route handler 与 `tsc --noEmit` 同时接受 | 构建通过、类型检查 exit 0 | 通过 |
| 3 | SSE 逐帧刷新（`next dev` 与 `next start` 各测一次） | 三帧间隔≈400 ms，不是最后一次性到达 | 通过 |
| 4 | HMR 下 `globalThis` 单例 | 改文件后再写入仍连续，无 `database is locked` | 通过 |
| 5 | 只监听 `127.0.0.1` | `lsof -nP -iTCP:4173 -sTCP:LISTEN` 只有一行且是 `127.0.0.1` | 通过 |
| 6 | 大请求体 | 5 MB JSON 被 route handler 正常接收 | 通过 |

若某天发现 Node 或 Next 升级后这些行为变了，先改这里，再改代码。

这 6 项现在大部分可以重跑：第 1、2、3、5 项与「请求体上限」由 `npm run accept` 覆盖（第 3 项另见 `tools/acceptance/real-pi/` 的 SSE 探针），第 4 项由 `tools/acceptance/real-pi/hmr.sh` 覆盖。注意第 6 项当初验证的是「框架没有默认请求体上限」，本仓库的产品上限是 2 MB → 413，`npm run accept` 的 A5 断言的是后者。

---

## 15. 已同步进 PRD 的 5 处（本次已改）

| 处 | 原状 | 已改成 |
|:--|:--|:--|
| §0.1 已确认决策 | 无 T1 条目 | 新增 C8：应用形态 Next.js 16；原型是设计产物，不作为产品代码 |
| §8.1 驱动 | 只写「`node:sqlite`，要求 Node ≥ 24，开启 WAL」 | 补初始化顺序（`auto_vacuum` 必须在建表前、`journal_mode=WAL`、`synchronous`、建表、`user_version`），并写明只在服务端引用、连接挂 `globalThis` |
| §8.6 保留与清理 | 只写「每天一次 VACUUM」 | 补：**VACUUM 之后必须跟一次 `PRAGMA wal_checkpoint(TRUNCATE)`**，否则磁盘空间不释放（实测见附录 A.6） |
| §11 页面 | 「页面原型见 `prototype/`（作为开发参考）」 | 改为「设计产物」：提供视觉规范与信息结构，产品界面按 React 组件重写，只沿用设计约定与 token 值 |
| §12 启动方式 | `npm run dev` / `npm run start`；探针路径写 `packages/probe` | 补 `-H 127.0.0.1 -p 4173` 的说明（Next 默认监听 `0.0.0.0`）；探针路径统一为 `ext/` |

另外在 PRD §15 增加一条风险：Next 大版本改变默认行为 → 锁 `16.4.x`、升级前跑 M1 验收、监听地址永远显式写在脚本里。

---

## 附录 A 本机实测记录（Node / SQLite 层，2026-10-19）

环境：macOS 27.0.1 / Apple M1 Pro / arm64 / Node v26.5.0 / npm 11.17.0 / pnpm 11.16.0；磁盘可用 120 GiB。SQLite 相关实测跑在 26.5.0 的 `DatabaseSync` 上（本机导出名，见 A.3）。

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

能力：见 §4.2 表（WAL 生效、外键默认开、JSON1 可用、无 `db.transaction()`、大整数需 `readBigInts`）。

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
| `import ... from "./util"`（省略后缀） | 失败：`ERR_MODULE_NOT_FOUND` |
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
// src/lib/db.ts（只在服务端引用；只在 nodejs runtime 生效）
// 本机 26.5.0 导出的名字是 DatabaseSync；上游新版已改名 Database，故留一个别名收口
import { DatabaseSync as Db } from "node:sqlite";

const db = new Db("data/observer.db", { timeout: 5000 }); // 内置 busy_timeout
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");   // WAL 下的常规选择
// 若要用增量回收，必须在建表前设置：
// db.exec("PRAGMA auto_vacuum = INCREMENTAL");
db.exec(SCHEMA_SQL);  // src/lib/schema.ts 里的内联 DDL（构建后读不到相对路径的 .sql）
// 迁移：PRAGMA user_version（实测可读写，本例 0 → 1）

// 每天一次的空间回收（PRD §8.6）
db.exec("BEGIN IMMEDIATE");
db.prepare("DELETE FROM events WHERE received_at < ?").run(cutoffIso);
db.prepare("UPDATE llm_requests SET payload = '{\"deleted\":true}', response_headers = '{\"deleted\":true}' WHERE created_at < ?").run(cutoffIso);
db.exec("COMMIT");
db.exec("VACUUM");                                   // 不能在事务里跑
db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); // 关键：没有这一步，磁盘不释放
```

---

## 附录 C Next.js 侧实测记录（本次，2026-10-19）

### C.0 环境与安装

在临时目录建一个最小 Next 工程（不放进本仓库）：

| 项 | 实测 |
|:--|:--|
| `next` / `react` / `react` 版本 | 16.4.2 / 19.3.1 / 19.3.1 |
| `next` 的 `engines.node` | `>=20.9.0` |
| 安装耗时 | 运行时依赖 3 分钟（22 个包）+ 开发依赖 13 秒（7 个包） |
| Node | v26.5.0（本机） |
| 构建器 | Turbopack（Next 16 的 `dev` / `build` 默认值） |

### C.1 `node:sqlite` 在 route handler 内可用

`POST /api/db`，`runtime = "nodejs"`：

```text
第一次：{"sqlite":"3.53.3","row":{"id":"a","n":1}}
第二次：{"sqlite":"3.53.3","row":{"id":"a","n":2}}
```

同时生成了 `probe.db` / `probe.db-wal` / `probe.db-shm`，说明 WAL 生效、`ON CONFLICT DO UPDATE` 正常、单例在多次请求间保持。

### C.2 `.ts` 后缀的相对导入两边都接受

| 检查 | 结果 |
|:--|:--|
| `next build`（`src/app/api/store/route.ts` 里 `import { summarize } from "../../../lib/store.ts"`，而 `store.ts` 内部 `import { label } from "./helper.ts"`） | 通过（`✓ Compiled successfully in 254ms`） |
| `next start` 下请求该接口 | `{"text":"a:n=1"}` |
| `tsc --noEmit`（`allowImportingTsExtensions: true`） | exit 0 |
| Next 对 `tsconfig.json` 的自动改写 | 只改了 `jsx: react-jsx` 与 `include`（补 `.next/dev/types/**/*.ts`），**保留了 `allowImportingTsExtensions`** |

### C.3 SSE 逐帧刷新（两端一致）

route handler 返回 `ReadableStream`，每 400 ms 发一帧；客户端记录每块到达时间：

| 运行方式 | 第 1 帧 | 第 2 帧 | 第 3 帧 | 结束 |
|:--|:--|:--|:--|:--|
| `next start`（生产） | 27 ms | 429 ms | 831 ms | 1235 ms |
| `next dev`（开发） | 97 ms | 497 ms | 899 ms | 1305 ms |

响应头：`content-type: text/event-stream; charset=utf-8`、`cache-control: no-cache, no-transform`。结论：**没有缓冲**，不需要为 SSE 另起一个 `node:http` 端口。

### C.4 HMR 下 `globalThis` 单例有效

开发态 `touch src/lib/db.ts` 触发热重载后连续写入：`n` 依次为 4 → 5 → 6，连续无回退；`lsof probe.db` 只有一个 node 进程持有句柄；日志无 `database is locked`。说明「把连接挂 `globalThis`」这条要求确实必要且有效。

### C.5 route handler 无默认请求体上限

向 `/api/db` 发 5 MB JSON（远超我们自设的 2 MB 批次上限）：正常接收并写入。所以体积上限必须由我们自己的校验函数执行。

### C.6 监听地址

`next start -H 127.0.0.1 -p 4173`：

```text
COMMAND   PID       USER   FD   TYPE   ...  NODE NAME
node    45233 jiangjiang   12u  IPv4   ...  TCP 127.0.0.1:4173 (LISTEN)
```

只有一行、只有回环地址。对照官方 CLI 文档：`dev` 与 `start` 的 `-H/--hostname` 默认值都是 `0.0.0.0`，所以这一项必须显式写。

### C.7 Next 16 的两个附带行为

- `next dev` 自动生成根目录 `AGENTS.md`（内容形如 `<!-- BEGIN:nextjs-agent-rules -->`），并提示可用 `agentRules: false` 关闭。本仓库已有 `AGENT.md`，建议关掉避免两份规则文件。
- 开发构建输出到 `.next/dev`，生产输出到 `.next`，可以同时存在；`.next/` 已在 `.gitignore`。
