# pi-observer

Pi 运行时数据的只读本地看板。

它把 Pi 的会话文件（JSONL）和 Pi 进程内探针上报的事件合到一起，在一个页面里看每轮对话、请求、工具调用、用量与钩子。

## 边界

- **只读**：不写 Pi 的任何文件，不调用 Pi 的写入接口，不改变会话状态。
- **单用户、单机**：服务固定监听回环地址，不提供账号体系，不做远程访问。
- **不做会话管理**：不删除、不隐藏、不重命名 Pi 的会话。
- **不推定**：取不到的字段在界面和数据里标「不可用」，不用默认值补齐。
- **正文存文件**：完整正文（模型请求体、钩子事件、会话条目）写进 `data/payloads/`，数据库只留元信息与相对路径。看板不再往库里堆正文，数据库体积可以忽略。
- **不自动删数据**：没有保留期，到期也不清。容量由使用者自己控制：设置页能看到占用，变大了就自己导出或删除正文文件。
- **令牌只保护写接口**：`/api/ingest` 与 `/api/backfill` 需要 `x-observer-token`；读接口不校验，因为服务只在回环地址上。

## 界面

单页：左侧是项目分组与会话列表，右侧直接打开该会话的时间线；地址栏用 `?session=<id>` 同步当前会话，刷新或前进后退都能回到同一个会话。

| 区域 | 行为 |
|:--|:--|
| 会话列表 | 按项目（cwd）分组，显示会话名（没有则首条用户消息）、运行状态、Turn 数与最近活动时间 |
| 时间线 | Turn 默认折叠；默认最近 20 个，「加载更早」每次再加 20 个；倒序，打开停在顶部 |
| 行详情 | 每行行首的 `more` 按钮打开弹窗：钩子入参、关联条目/请求/工具、原始 JSON；回填行进弹窗标「来自文件」 |
| 请求对比 | 请求行的弹窗里多一个「对比上一条」页签：同一个会话里相邻两次请求的完整请求体逐行对比，增删行着色，没变的部分折叠 |
| 设置 | 顶栏「设置」进设置页：数据库与正文文件分别占多少、各类记录多少条、占空间最多的会话 |
| 顶部筛选 | 按组开关：消息 / 会话 / 运行 / 工具 / 模型 / 探针；默认全开，写入 `localStorage` |
| 主题 | 亮色 / 暗色切换，亮色底色为中性灰 |
| 实时 | 活跃会话每秒增量读文件；SSE 负责「有新数据」的通知，不传正文 |

## 快速开始

要求 Node `>=24 <27`（存储用内置的 `node:sqlite`）。

```bash
npm install
npm run dev
# 打开 http://127.0.0.1:4173
```

首次启动会建库并扫描 Pi 会话目录；`data/token` 在第一次调用写入接口时生成（权限 `0600`）。数据都放在 `data/`，已被 `.gitignore` 排除。

生产方式：

```bash
npm run build
npm start
```

## 接入 Pi

探针是 Pi 扩展，源码在 `ext/`。两种加载方式，**只选一种**，同时用会重复加载。

**方式 A：个人扩展转发（推荐，重启 Pi 后一直生效）**

```bash
mkdir -p ~/.pi/agent/extensions
cat > ~/.pi/agent/extensions/pi-observer.ts <<'EOF'
export { default } from "/绝对路径/pi-observer/ext/index.ts";
EOF
```

改完重启 Pi 或执行 `/reload`。仓库更新后不需要再复制文件；想停用就把这个转发文件删掉或改名。

**方式 B：临时加载（适合验收脚本）**

```bash
pi --extension /绝对路径/pi-observer/ext
```

验证是否生效：

```bash
curl -s http://127.0.0.1:4173/api/health
```

返回里有 `version`（探针版本，当前 `0.3.0`）、`protocol`（当前 `3`）和 `probe`（最近上报时间、积压与丢弃计数）。页面右上角的探针状态也来自同一个接口。

## 数据从哪来

| 来源 | 提供什么 | 时机 |
|:--|:--|:--|
| 会话 JSONL（真相源） | 消息条目、Turn、工具调用、token 与成本、缓存读写 | 服务启动扫描；活跃会话每秒增量读；`agent_settled` 后 3 秒再对账一次 |
| 探针事件 | 请求/响应、钩子记录、工具结果补充、会话生命周期 | 批量 `POST /api/ingest`，队列上限 2000 条 / 64 MB |

约束：

- 消息正文不经过探针，由服务端直接读文件，避免重复传输。
- 正文不随批次传输：探针把请求体与事件正文写成文件，批次里只带相对路径与字节数。这样一条几 MB 的请求也不会把批次上限或内存队列撑爆。
- 正文不截断、不脱敏：文件里是原样的请求体。数据库里另存一份「骨架」（结构保留、长字符串截短），时间线与工具列表直接读它。
- 探针的所有 handler 返回 `undefined` 并包在 `try/catch` 里；服务不可用时只进有界队列，不阻塞 Pi。

## 目录结构

```
src/app/            页面与 API 路由（Next.js App Router，全部 nodejs 运行时）
src/components/     单页外壳、会话列表、时间线、详情弹窗
src/lib/            协议契约、入库、回填、对账、查询、正文文件、差异、存储统计
ext/                Pi 探针（扩展）源码
probes/             一次性测量脚本，不参与运行时
tools/              截图与验收脚本
test/               单元测试
docs/               PRD、技术选型、可行性验证
prototype/          设计基准（静态稿）
data/               运行数据：observer.db、token、probe.log、探针游标、payloads/ 正文文件（不进 git）
```

## 配置

服务端（环境变量，均有默认值）：

| 变量 | 默认 | 说明 |
|:--|:--|:--|
| `PORT` | `4173` | 监听端口，地址固定 `127.0.0.1` |
| `PI_OBSERVER_DATA_DIR` | `./data` | 库与令牌所在目录 |
| `PI_OBSERVER_SESSIONS_DIR` | `~/.pi/agent/sessions` | Pi 会话文件根目录 |
| `PI_OBSERVER_INGEST_MAX_BYTES` | `2097152` | 单批请求体上限 |
| `PI_OBSERVER_RECONCILE_DELAY_MS` | `3000` | `agent_settled` 后多久对账 |

探针：

| 变量 | 默认 | 说明 |
|:--|:--|:--|
| `PI_OBSERVER_URL` | `http://127.0.0.1:4173` | 看板地址 |
| `PI_OBSERVER_TOKEN_FILE` | `<仓库>/data/token` | 令牌路径（按探针文件位置解析，不依赖 Pi 的 cwd） |
| `PI_OBSERVER_PAYLOAD_DIR` | `<仓库>/data/payloads` | 正文文件根目录 |
| `PI_OBSERVER_BATCH_SIZE` | `50` | 队列到多少条立即发送 |
| `PI_OBSERVER_BATCH_INTERVAL_MS` | `300` | 定时发送间隔 |
| `PI_OBSERVER_MAX_QUEUE_RECORDS` | `2000` | 队列条数上限 |
| `PI_OBSERVER_DEBUG_REQUESTS` | 关闭 | 每次模型请求往日志写一行采集摘要 |
| `PI_OBSERVER_DEBUG` | 关闭 | 同时把探针日志打到 stderr |

探针日志默认只写 `data/probe.log`，**不进你的终端**：探针跑在 Pi 进程里，
打到 stderr 会在你打开的每个项目里冒出一条与本项目无关的消息。
用 `tail -f data/probe.log` 看；排查时才临时设 `PI_OBSERVER_DEBUG=1`。

## API

除写接口外都只读，且只在本机回环内可达。

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| `GET` | `/api/health` | 探针探活；返回协议版本、探针版本、库状态 |
| `POST` | `/api/ingest` | 探针批量上报，需 `x-observer-token` |
| `GET` | `/api/sessions` | 会话列表与概览指标 |
| `GET` | `/api/session?id=&v=` | 单会话时间线；`v` 与当前版本一致时只回 `{unchanged:true}` |
| `GET` | `/api/stream` | SSE，只推标识与版本号 |
| `GET` | `/api/detail?session=&kind=&id=&related=` | 行详情（消息 / 工具 / 请求 / 事件） |
| `POST` | `/api/backfill` | 手动补读，需令牌；文件没变则全部跳过 |
| `GET` | `/api/sessions/[id]/cursor` | 会话已用的最大序号，供探针种子化 |

## 开发与验证

```bash
npm test         # 单元测试
npm run typecheck
npm run build
npm run check    # test + typecheck + build
npm run accept   # 离线验收，临时目录与空闲端口，不碰真实数据
npm run verify   # check + accept
```

档 A（`npm run accept`）共 27 项，覆盖建库、鉴权、入库幂等、截断、SSE、单页、回填、对账与状态推进、行详情、请求与用量、保留期与状态自愈。

档 B 需要真实 Pi 和真实服务，会花 token，其中两项会重启 4173：

| 脚本 | 验证什么 |
|:--|:--|
| `tools/acceptance/real-pi/tree-compare.mjs` | 消息树与文件逐条一致 |
| `tools/acceptance/real-pi/live-session.mjs` | 活跃会话跟随文件增长，事件延迟 |
| `tools/acceptance/real-pi/request-capture.mjs` | 请求/响应配对，序号不覆盖 |
| `tools/acceptance/real-pi/overhead.mjs` | 探针 CPU 开销（逐对交替测量） |
| `tools/acceptance/real-pi/latency.mjs` | 写入到页面可见的延迟 |
| `tools/acceptance/real-pi/downtime.sh` | 服务停机期间的事件积压与恢复 |
| `tools/acceptance/real-pi/hmr.sh` | 服务重启/热更新时不丢数据、不锁库 |

## 文档

- `docs/prd-v0.2.md`：产品口径、数据来源、事件清单、页面与验收判据
- `docs/tech-stack.md`：技术选型与版本约束
- `docs/durable-feasibility.md`：可行性验证与实测数据
- `prototype/`：视觉与交互基准
- `tools/acceptance/README.md`：验收脚本细节
- `AGENT.md`：协作约束（回答方式、git 策略）
