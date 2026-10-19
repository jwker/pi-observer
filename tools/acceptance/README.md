# 验收脚本

分两档，互不依赖。

| 档 | 命令 | 需要什么 | 会不会有副作用 | 覆盖什么 |
|:--|:--|:--|:--|:--|
| **A 离线** | `npm run accept` | 什么都不需要（首次会自动 `next build`） | 没有。跑在临时数据目录与空闲端口上 | 建库 → 写入 → 落库 → SSE → 页面 → 回填 → 消息树 → 会话列表 → 对账与状态推进 → 截短重读 → 请求采集，共 23 项断言 |
| **B 真实 Pi** | 见下表 | `pi` 在 PATH 上、真实服务端在跑、会在真实会话里调用模型 | **有**：花 token；其中两条会杀 4173 的监听进程 | PRD §14 里「探针不卡顿 / 强杀恢复 / 读写并发」这些只能在真实会话上量的判据 |

`npm test` 与 `npm run check` 是单元测试与类型/构建检查，不在这里；`npm run verify` =
`check` + `accept`。

## 档 A：`npm run accept`

23 项检查（A1–A23）。A1–A13 在第一个隔离实例上：

健康检查、空库页面、无令牌与错令牌被拒、超大请求体被拒、合法批次落库、重复投递幂等、
单条超大 payload 被截断打标、写入到可见的延迟、SSE 逐帧推送、会话详情页可打开且含正文、
落库真相（WAL / 行数 / 唯一性）、数据隔离。

A14–A16 另起第二个隔离实例（会话目录里先放好一份合成会话文件），覆盖 M2-2 回填入库：

| 项 | 覆盖 |
|:--|:--|
| A14 | 启动扫描：没经过任何 HTTP 写入，事先存在的会话文件已入库；`source=backfill`、`state` 保持 `idle`、条目 / turn / 工具调用 / token / 成本 / 缓存读写与文件一致 |
| A15 | 进页面补读：启动之后往文件里追加一条，页面请求后库里多出这一条（页面请求前先断言库里还没有） |
| A16 | 手动触发 `POST /api/backfill`：无令牌 401；带令牌因文件没变而全部跳过；两次触发不产生重复行 |

A17–A18 同一个隔离实例，覆盖 M2-3 消息树（只读接口 + 首屏渲染）：

| 项 | 覆盖 |
|:--|:--|
| A17 | 索引接口：按文件行号排序、`parent_id` 与文件一致、**行里不带 payload**、摘要截到 200 字符、payload 字节数可查 |
| A18 | 单条详情接口：给原始条目（role / tokens 与文件一致），不存在的条目 404；详情页首屏 HTML 里已经有树（`node-line`）、用户正文与非当前分支标记 |

A19 同一个隔离实例，覆盖 M2-4 会话列表页：

| 项 | 覆盖 |
|:--|:--|
| A19 | 列表接口带首条用户消息摘要与概览指标（类型 + 未对账会话数）；首屏 HTML 有项目分组、摘要、「未对账」标记、列头与概览指标、页头会话总数 |

A20–A21 同一个隔离实例，覆盖 M2-5 对账与状态推进：

| 项 | 覆盖 |
|:--|:--|
| A20 | `agent_settled` 后 3 秒对账：settle 时先断言条目还没入库，等定时器落地后文件里新增的条目入库、`source` 变 `merged`、`last_reconciled_at` 有值 |
| A21 | `session_shutdown`：服务端把状态推进到 `ended`；列表里不再是「未对账」，概览的「最近对账」不再是空 |
| A22 | 会话文件被截短（模拟整文件重写）：识别为「变了」并从头重读，行数 = 去重后的 entry_id 数（不产生重复条目） |
| A23 | 请求开始 → 响应两次写同一 `(session_id, request_seq)`：payload 里的 `authorization` / `x-api-key` 被脱敏（服务端再脱一次），`payload_bytes` 等于脱敏前原始长度，响应状态码与 headers 落库，时间线出现 `provider_request` / `provider_response` |

隔离靠三件事，所以它**永远不会碰你的真实数据**：

1. `PI_OBSERVER_DATA_DIR` 指向临时目录 → 用临时 `observer.db` 与临时令牌；
2. `PI_OBSERVER_SESSIONS_DIR` 指向临时目录（第二个实例里放的是合成会话文件）→ 不会去扫你真实的会话文件；
3. 端口取自系统的空闲端口 → 不撞 4173，也不需要杀掉你正在跑的服务。

失败时打印哪一项、期望与实际，退出码 1，并**保留全部临时目录**（含服务端日志）供排查；
全通过才清掉临时目录。

## 档 B：真实 Pi

| 脚本 | 对应判据 | 副作用 |
|:--|:--|:--|
| `node tools/acceptance/real-pi/latency.mjs [cwd关键字] [秒数]` | PRD §14 M1 第 1 条（2 秒内可见） | 只读，不花钱；测量期间需要真的在跟 Pi 对话 |
| `node tools/acceptance/real-pi/overhead.mjs [轮数]` | PRD §14 M1 第 2 条（偏差 ≤ 10%） | **调用真实模型**（默认 12 次请求） |
| `zsh tools/acceptance/real-pi/downtime.sh` | PRD §14 M1 第 3 条（强杀恢复） | **调用真实模型**，并**杀掉 4173 的监听进程**后自行重启 |
| `zsh tools/acceptance/real-pi/hmr.sh` | 技术选型 §14 检查 4（HMR 不锁库） | **杀掉 4173 的监听进程**并改起 `next dev`；临时改 `src/app/page.tsx` 后恢复；跑完 4173 上是 dev，要换回生产服务得手动重启 |
| `node tools/acceptance/real-pi/tree-compare.mjs [cwd关键字]` | PRD §14 M2 第 1 条（消息数与 Pi 的 `/tree` 一致） | 只读；用 `pi --export` 导出的 `{header, entries, leafId}` 与看板逐条对照。**不调模型** |
| `node tools/acceptance/real-pi/live-session.mjs ["提示词"]` | PRD §14 M2 第 2 条（写入时读取不失败）+ M2-5 的 settle→idle + M1 第 1 条（事件延迟） | **调用真实模型**（1 轮）；起隔离实例（临时库 + 临时会话目录 + 空闲端口），不碰真实的 `data/` 与 4173 |
| `node tools/acceptance/real-pi/request-capture.mjs` | PRD §14 M3 前两条 + `request_seq` 跨进程不重置 | **调用真实模型**（2 轮、每次 1 个请求）；起隔离实例，第一次新建会话、第二次 `--resume` 同一个会话文件；断言 payload 脱敏、`payload_bytes` 与探针打印一致、状态码与响应头可见 |

前两条的前置是「`npm run start` 已经在跑」；`latency.mjs` 的服务端地址可用
`PI_OBSERVER_URL` 覆盖。脚本产物（日志、临时会话文件）都写在
`$TMPDIR/pi-observer-accept-real/<脚本名>/`，不落在仓库里。

## 已知边界

- `src/app/**` 与 `src/components/**` 没有自动覆盖：档 A 只验证它们「能被打开、包含应有内容」，
  不验证交互细节（实时正文开关、分页、筛选这些靠人看）。
- `tree-compare.mjs` 依赖 `pi --export` 的内嵌 `session-data`（base64 的 `{header, entries, leafId}`）。
  升级 Pi 后如果导出结构变了，脚本会直接报错而不是悄悄通过。
- `live-session.mjs` 的 `pi -p` 跑完就退出，**看不到 idle 停留窗口**：它记录的是 settle 的入库延迟
  （idle 与 settle 在探针的同一批里写入），以及最终状态 `ended`。
- `request-capture.mjs` 只验证「一次请求一行、响应补齐、跨进程序号继续」；**没有人为制造重试/重发**。
  Pi 内部的 HTTP 重试包在一次 `before_provider_request` / `after_provider_response` 之间，探针看不到每次尝试，
  只记一条（最终状态码）；应用层新发起的请求会产生新序号。
- 请求与响应没有共享 ID，只能按顺序配对（`serial_assumed`）；同一时间只保留一个待响应请求，新的请求会放弃未响应的旧请求（典型是用户中断）。
- 请求 payload 是结构化对象，不是 wire 级字节；响应只有状态码与 headers，没有 body（PRD §4.5）。
- 档 A 的延迟是直投 HTTP 的往返，不含探针的 300 ms 批量间隔；那条在 `latency.mjs` 里量。
- 冒烟通过不等于验收通过：里程碑判据以 `docs/prd-v0.2.md` §14 为准，档 B 才是那些判据的证据来源。
