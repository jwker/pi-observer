# 验收脚本

分两档，互不依赖。

| 档 | 命令 | 需要什么 | 会不会有副作用 | 覆盖什么 |
|:--|:--|:--|:--|:--|
| **A 离线** | `npm run accept` | 什么都不需要（首次会自动 `next build`） | 没有。跑在临时数据目录与空闲端口上 | 建库 → 鉴权 → 入库 → SSE → 单页 → 回填 → 对账 → 截短重读 → 请求与用量 → 保留期 → 状态自愈 → 拒因可见，共 28 项断言 |
| **B 真实 Pi** | 见下表 | `pi` 在 PATH 上、真实服务端在跑、会在真实会话里调用模型 | **有**：花 token；其中两条会杀 4173 的监听进程 | PRD §14 里「探针不卡顿 / 强杀恢复 / 读写并发」这些只能在真实会话上量的判据 |

`npm test` 与 `npm run check` 是单元测试与类型/构建检查，不在这里；`npm run verify` =
`check` + `accept`。

## 档 A：`npm run accept`

27 项（A1–A27），全部跑在隔离实例上：临时数据目录、临时会话目录、系统空闲端口。不会碰真实的 `data/`，也不占 4173。

| 组 | 项 | 覆盖 |
|:--|:--|:--|
| 基础与鉴权 | A1–A6b | 健康检查（协议 v4、schema 版本、探针状态如实为空）；空库单页可用；无令牌与错令牌写入被拒；超大请求体被拒；旧协议（v2 / v3）整批被拒；**拒批原因能从 `/api/health` 的 `recent_problems` 读到（含 `extra` 里的原因）** |
| 入库与推送 | A7–A11 | 合法批次落库（会话 / 事件 / Turn / 工具 / 请求）；重复投递幂等；单条超大 payload 截断打标；写入到可见的往返延迟；SSE 逐帧推送不合并 |
| 单页与落库真相 | A12–A15 | 轮询版本未变只回 `unchanged`；单页 HTML 左右栏都在；WAL、行数与唯一性；只写临时库 |
| 回填 | A16–A18 | 启动扫描入库且字段与文件一致；进页面补读启动后新增的条目；手动 `POST /api/backfill` 要令牌、文件没变则跳过、两次不重复 |
| 时间线与详情 | A19–A20 | 一个用户 Turn 一组、`prelude` 装首条用户消息之前的条目；行详情按需取全（正文、工具参数与结果） |
| 生命周期 | A21–A23 | `agent_settled` 后 3 秒对账、`live` 变 `merged`；`session_shutdown` 推进到已结束；文件被截短识别为重写并从头重读 |
| 请求与用量 | A24–A25 | 请求 payload 脱敏、原始字节数、响应状态与 headers 落库；会话级与 Turn 级 token / 缓存 / 成本口径一致 |
| 保留与自愈 | A26–A27 | 过期 payload 清空、事件删除、元信息保留；文件已不存在的 `active` 会话改为 `ended`，重复执行幂等 |

隔离靠三件事，所以它**永远不会碰你的真实数据**：

1. `PI_OBSERVER_DATA_DIR` 指向临时目录 → 用临时 `observer.db` 与临时令牌；
2. `PI_OBSERVER_SESSIONS_DIR` 指向临时目录（部分实例里放的是合成会话文件）→ 不会去扫你真实的会话文件；
3. 端口取自系统的空闲端口 → 不撞 4173，也不需要杀掉你正在跑的服务。

失败时打印哪一项、期望与实际，退出码 1，并**保留全部临时目录**（含服务端日志）供排查；
全通过才清掉临时目录。

## 档 B：真实 Pi

| 脚本 | 对应判据 | 副作用 |
|:--|:--|:--|
| `node tools/acceptance/real-pi/latency.mjs [cwd关键字] [秒数]` | PRD §14 M1 第 1 条（2 秒内可见） | 只读，不花钱；测量期间需要真的在跟 Pi 对话 |
| `node tools/acceptance/real-pi/overhead.mjs [轮数]` | PRD §14 M1 第 2 条（偏差 ≤ 10%） | **调用真实模型**（默认 12 次请求）；逐对交替测，判据看 CPU 时间 |
| `zsh tools/acceptance/real-pi/downtime.sh` | PRD §14 M1 第 3 条（强杀恢复） | **调用真实模型**，并**杀掉 4173 的监听进程**后自行重启 |
| `zsh tools/acceptance/real-pi/hmr.sh` | 技术选型 §14 检查 4（HMR 不锁库） | **杀掉 4173 的监听进程**并改起 `next dev`；临时改 `src/app/page.tsx` 后恢复；跑完 4173 上是 dev，要换回生产服务得手动重启 |
| `node tools/acceptance/real-pi/tree-compare.mjs [cwd关键字]` | PRD §14 M2 第 1 条（消息数与 Pi 的 `/tree` 一致）+ M3-5（用量与 JSONL `usage` 一致） | 只读；用 `pi --export` 导出的 `{header, entries, leafId}` 与看板逐条对照，并从 entries 现算 token / 缓存 / 成本与接口比对。**不调模型** |
| `node tools/acceptance/real-pi/live-session.mjs ["提示词"]` | PRD §14 M2 第 2 条（写入时读取不失败）+ M2-5 的 settle→idle + M1 第 1 条（事件延迟） | **调用真实模型**（1 轮）；起隔离实例（临时库 + 临时会话目录 + 空闲端口），不碰真实的 `data/` 与 4173 |
| `node tools/acceptance/real-pi/request-capture.mjs` | PRD §14 M3 前两条 + `request_seq` 跨进程不重置 | **调用真实模型**（2 轮、每次 1 个请求）；起隔离实例，第一次新建会话、第二次 `--resume` 同一个会话文件；断言 payload 脱敏、`payload_bytes` 与探针打印一致、状态码与响应头可见 |

前两条的前置是「`npm run start` 已经在跑」；`latency.mjs` 的服务端地址可用
`PI_OBSERVER_URL` 覆盖。脚本产物（日志、临时会话文件）都写在
`$TMPDIR/pi-observer-accept-real/<脚本名>/`，不落在仓库里。

档 B 脚本统一用 `-ne -e <仓库>/ext` 加载探针：禁用扩展发现，避免和你个人的
`~/.pi/agent/extensions/pi-observer.ts` 重复加载。

## 已知边界

- 页面交互细节（主题、筛选、Turn 折叠、加载更早、弹窗滚动）没有自动覆盖：档 A 只验证首屏
  HTML 里包含应有内容，交互靠人看。
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
- **401 后的令牌自愈没有在真实环境演练**：改 `data/token` 会打断当时正在跑的 Pi 会话，
  所以只由 `test/probe-flush.test.ts` 覆盖（清缓存 + 退回队列 + 退避 1s）。真要验证的话，
  停掉所有 Pi 进程后 `mv data/token data/token.bak` 再让服务重新生成，最后把文件换回来。
- 状态栏的「最近拒批」是客户端渲染的（数据来自 `/api/health` 的 `recent_problems`），
  档 A 只断言接口带上原因，视觉呈现靠人看。
- 冒烟通过不等于验收通过：里程碑判据以 `docs/prd-v0.2.md` §14 为准，档 B 才是那些判据的证据来源。
