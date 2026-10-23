# pi-observer 本地看板 PRD

| 项 | 内容 |
|:--|:--|
| 版本 | v0.2 |
| 状态 | 草案，待实现 |
| 日期 | 2026-10-19 |
| 依据 | Pi 1.3.0 本机实测（见附录 A） |
| 形态 | 本地 Web 看板：Next.js 服务跑在本机，浏览器访问 `127.0.0.1` |
| 技术栈 | Next.js + TypeScript + `node:sqlite` + Pi Extension（探针） |
| 边界 | 单用户、单机、只读、无远程访问、无多租户 |

---

## 0. 本版变更

| 章节 | v0.1 | v0.2 |
|:--|:--|:--|
| 名称 | Pi 本地看板 / `pi-data-dashboard` | `pi-observer` |
| 数据类别 | 四类，含 Durable | 三类：会话历史、生命周期事件、模型请求 |
| Durable | 一整节，含只读旁路 SQLite | **整节删除**（D6）。本机不存在 Durable 运行时 |
| 事件清单 | 含不存在的 `session_switch`，缺 `agent_settled` 等 | 按 Pi 1.3.0 类型定义重写 |
| 结束判断 | 静默窗口 | `agent_settled` |
| 幂等 | 无 | `messageEntryId` / `toolCallId` / 探针事件 ID |
| 内容路径 | 事件推正文 + 文件回填，两条路各存一份 | **只有一条**：会话文件 → `messages.payload`；事件只补文件里没有的信息 |
| 页面形态 | 会话列表页 + 独立详情页 + 消息树面板 | **单页**：左栏项目 / 会话，右栏时间线；详情用弹窗 |
| 驱动 | better-sqlite3 | `node:sqlite`（D1） |
| 历史解析 | 未定义 | 只消费完整行、检测重写、按 id 去重 |
| 探针约束 | 未写 | 独立一节，含队列上限与丢弃计数（D5） |
| 验收 | 无 | 每个里程碑有可验证的完成判据 |

### 0.1 已确认决策

| 编号 | 决策 |
|:--|:--|
| C1 | 端口 `4173` |
| C2 | 不显示流式正文：正文只在会话文件里，生成中显示「生成中」 |
| C3 | 看板自有库用 `node:sqlite` |
| C4 | 不做会话删除、隐藏、重命名等写操作 |
| C5 | 正文存文件（`~/.pi-observer/payloads/`），数据库只留元信息、相对路径与截短骨架；**不脱敏、不截断** |
| C6 | 不自动删数据：没有保留期，容量由使用者自己控制（设置页能看到占用） |
| C7 | 代码与文档纳入 git 版本控制 |
| C8 | 应用形态 Next.js 16（App Router / Node Runtime）；`prototype/` 是设计产物，不作为产品代码 |
| C9 | 看板是单页：`/` 左侧项目 / 会话，右侧时间线；请求与工具详情用弹窗 |
| C10 | 正文只有一份：完整正文在 `~/.pi-observer/payloads/`，库里只留路径与截短骨架 |

---

## 1. 定位与目标

### 1.1 一句话

把 Pi 的内部运行时摊开给你看，且只看不改：浏览历史会话，旁观正在发生的 Turn 与工具调用，核对每次模型请求的参数与花费。

### 1.2 问题

Pi 的数据分散在两处，且没有统一界面：

- 会话历史在 `~/.pi/agent/sessions/` 的 JSONL 文件里，只能通过 Pi 自己的界面查看；
- 实时过程（Turn、工具执行、模型请求）只在 Pi 进程内可见，会话结束后无法回看。

### 1.3 目标

| 编号 | 目标 | 数据来源 |
|:--|:--|:--|
| G1 | 按会话、按项目浏览消息树与完整内容 | 会话 JSONL |
| G2 | 旁观正在发生的 Session / Agent / Turn / Message / Tool 事件 | 扩展事件 |
| G3 | 核对每次模型请求的 provider、model、请求内容、状态码、token 与成本 | 扩展事件 + 会话 JSONL |

### 1.4 "只读"的可执行定义

这不是口号，而是五条可以检查的约束：

1. 探针不修改任何消息、工具参数、工具结果或会话文件。
2. 探针不注册任何会拦截或改变 Pi 行为的能力：不拦截工具、不改上下文、不注入消息、不写自定义条目。
3. 探针的 handler 不阻塞事件流：不做同步 IO、不 await 网络请求。
4. 看板的任何接口都不具备控制 Pi 的能力：没有启动、停止、发送消息、切换会话之类的方法。
5. 探针异常时不影响 Pi：所有 handler 内部捕获异常，出错只记录，不向 Pi 抛出。

### 1.5 非目标

- 不远程部署、不多用户、不做鉴权体系（仅本机回环 + 会话令牌）。
- 不控制 Pi，不做 Agent 驱动。
- 不实现"Durable 检查点看板"。本机 Pi 1.3.0 不存在该运行时。
- 不替代 Pi CLI。
- 不解析或展示 Pi 的凭据。
- 不做会话的删除、隐藏、重命名等写操作，界面不提供任何修改入口。

---

## 2. 用户与场景

唯一用户：在本机同时开着 Pi 和看板的人。

| 场景 | 说明 | 依赖 |
|:--|:--|:--|
| S1 旁观长任务 | Pi 在跑长任务，在旁边看 Turn 推进、工具调用、正在生成的正文 | 实时事件 |
| S2 复盘已结束会话 | 按 Turn 和 Tool 粒度回看每一步 | 历史回填 |
| S3 核对某次请求 | 用的哪个 provider/model、带了什么、花了多少 token | 实时事件 + JSONL |
| S4 定位异常 | 哪一步出错、工具报了什么、是否重试 | 实时事件 + JSONL |

---

## 3. 术语

| 术语 | 含义 |
|:--|:--|
| 会话（session） | 一个 JSONL 文件，首行是 `session` 头 |
| 条目（entry） | JSONL 中的一行，有 `id` 与 `parentId`，构成树 |
| 分支（branch） | 从某个条目派生的另一条路径，同一文件内共存 |
| 运行（run） | 一次 `agent_start` 到 `agent_settled` 的过程；`turnIndex` 在每次运行开始时归零 |
| Turn | 一次模型请求/响应周期，一个运行内从 0 递增 |
| 消息（message） | user / assistant / toolResult / system / custom |
| 工具调用（tool call） | 一次工具执行，由 `toolCallId` 标识 |
| 探针（probe） | 加载进 Pi 进程的扩展，只采集与推送 |
| 回填（backfill） | 直接读取会话文件，把历史写入看板库 |

---

## 4. 数据来源

### 4.1 总表

| 数据 | 来源 | 可得性 | 备注 |
|:--|:--|:--|:--|
| 会话、分支、消息全文 | 会话 JSONL | ✅ | 真相源；**唯一的内容副本** |
| token、成本、模型、provider、耗时、响应 ID | 会话 JSONL 的 assistant message | ✅ | 含 `usage.cost` 明细 |
| 生命周期事件 | 扩展事件 | ✅ | 实时；只补文件里没有的信息 |
| 请求 payload | `before_provider_request` | ✅ | 原样写成文件；不脱敏、不截断 |
| 响应状态码与 headers | `after_provider_response` | ✅ | 不含响应 body |
| 响应正文 | 会话 JSONL 的 assistant message | ✅ | 不走事件；文件是唯一来源 |
| Durable 检查点 | — | ❌ | 本机不存在该运行时 |
| 遥测 | `pi-telemetry` | ❌ | 进程内诊断，禁止包含 prompt 与 payload |

### 4.2 会话文件（真相源）

位置与命名：

```text
~/.pi/agent/sessions/--<encoded-path>--/<timestamp>_<session-id>.jsonl
```

编码规则：去掉开头的路径分隔符，把 `/`、`\`、`:` 替换为 `-`。

格式：JSONL，v3。首行是 `session` 头（含 `id`、`cwd`、`version`，分叉会话还有 `parentSession`），其余每行是一个条目：

| 条目类型 | 作用 |
|:--|:--|
| `message` | 对话消息，`id` / `parentId` 构成树 |
| `model_change` | 会话中切换模型 |
| `thinking_level_change` | 切换思考等级 |
| `usage` | 不计入上下文的用量记录（如缓存预热） |
| `compaction` | 压缩摘要与检查点 |
| `context_edit` | 对更早条目的追加式修改 |
| `branch_summary` | 切换分支时对旧分支的摘要 |
| `custom` | 扩展写入的持久数据（不进入模型上下文） |
| `custom_message` | 扩展注入且进入上下文的消息 |
| `label` | 用户书签 |
| `session_info` | 会话显示名 |

助手消息里直接带有 `provider`、`model`、`api`、`usage`、`durationMs`、`responseId`、`stopReason`、`thinkingLevel`，所以 G3 的大部分字段不需要实时事件。

### 4.3 扩展事件（实时）

探针从 `session_start` 开始接收，到 `session_shutdown` 结束。事件清单与订阅策略见第 5 节。

### 4.4 模型请求与响应

- `before_provider_request`：拿到即将发送的 payload，可读不可改（返回 `undefined`）。
- `after_provider_response`：状态码与响应头；在响应流被消费之前触发，因此拿不到完整 body。
- 响应正文不走事件：它就是助手消息，在会话文件里，文件是唯一来源。

### 4.5 不可得与降级

| 数据 | 情况 | 处理 |
|:--|:--|:--|
| 响应 body 原始字节 | 钩子不提供 | 展示文件里的助手消息，不假装是原始响应体 |
| 请求的 wire 级字节 | 只有结构化 payload | 展示结构化 payload，标注"序列化前" |
| 请求与响应的强关联 | 没有共享请求 ID | 按会话内顺序配对，标注"按顺序关联" |
| 探针启动前的事件 | 未订阅 | 回填兜底，界面标注"仅历史" |
| 生成中的正文 | 事件里没有，也不从文件读半截 | 显示"生成中"占位，不显示流式正文 |

### 4.6 明确排除

| 来源 | 排除理由 |
|:--|:--|
| `@earendil-works/pi-durable` | 本机 Pi 1.3.0 未安装、未依赖；它是独立运行时库，不是 CLI 功能 |
| `@earendil-works/pi-telemetry` | 进程内诊断，非持久状态，规范禁止包含 prompt、工具参数与 payload |
| RPC 模式 | 需要由看板拉起一个 Pi 进程，读不到你终端里正在跑的会话 |
| 会话旁 `*.meta.json` | 由已卸载的第三方应用写入，写入方已不存在，字段会变旧 |

---

## 5. 事件清单与订阅策略

### 5.1 订阅原则

1. 只订阅需要的、且**不改变 Pi 行为**的事件。
2. 转换型事件（有返回值语义）只在必要时订阅，handler 一律返回 `undefined`，并用 `try/catch` 包住。
3. **不订阅** `tool_call`、`tool_result`、`context`、`context_with_system`、`before_agent_start`、`agent_before_settle`、`session_before_*`、`input`、`user_bash`。这些是拦截点或上下文改写点，对只读看板没有必要。
4. 不订阅 `provider_stream_event`：它按流顺序被 await，订阅会给每个流事件增加延迟，而 `message_update` 已能提供更粗粒度的内容。
5. 不订阅 `before_provider_headers`：它原地修改 headers，与只读原则冲突。

### 5.2 清单

**保留的事件**（协议 v3）：只推文件里没有的信息。

| 事件 | 层 | 类型 | 探针订阅 | 用到的字段 |
|:--|:--|:--|:--|:--|
| `session_start` | Session | 通知 | ✅ | 会话路径、ID、cwd |
| `session_info_changed` | Session | 通知 | ✅ | 显示名 |
| `session_compact` | Session | 通知 | ✅ | 压缩前后 token |
| `session_compact_failed` | Session | 通知 | ✅ | 失败原因 |
| `session_tree` | Session | 通知 | ✅ | 新旧 leaf、分支摘要 |
| `session_shutdown` | Session | 通知 | ✅ | 关闭原因 |
| `agent_start` | Agent | 通知 | ✅ | 运行边界（runSeq 自增） |
| `agent_end` | Agent | 通知 | ✅ | 本轮消息列表 |
| `agent_settled` | Agent | 通知 | ✅ | `aborted`；**会话是否空闲以此为准** |
| `turn_start` | Turn | 通知 | ✅ | 只记序号与时间，不推正文 |
| `turn_end` | Turn | 转换 | ✅ | 只记序号与 usage，不推正文 |
| `tool_execution_start` | Tool | 通知 | ✅ | `toolCallId`、`toolName`、`parentToolCallId` |
| `tool_execution_end` | Tool | 通知 | ✅ | `toolCallId`、`isError`、`durationMs` |
| `before_provider_request` | Provider | 转换 | ✅ | `payload` |
| `after_provider_response` | Provider | 通知 | ✅ | `status`、`headers` |
| `model_select` | Model | 通知 | ✅ | 新模型与来源 |
| `thinking_level_select` | Model | 通知 | ✅ | 新等级 |

**不订阅的事件**（协议 v3 起停推）：

| 事件 | 不订阅的理由 |
|:--|:--|
| `message_start` / `message_update` / `message_end` | 正文只在会话文件里。事件再推一份就成了第二份副本，两处会不一致 |
| `tool_execution_update` | 部分结果只是执行过程的中间态；最终结果在文件里 |
| `progress`（进度快照） | 它只是「这一轮还在写」的信号，用会话状态（`state=active`）表达更准确 |

说明：`turn_end` 是转换型事件，handler 返回 `undefined` 即为空操作；它带出的 usage 用来填 `turns` 表的 token / 缓存 / 成本，正文仍以文件为准。

---

## 6. 架构

```text
┌──────────────────────────────────────────────────────┐
│ Pi 进程（终端）                                       │
│                                                      │
│  probe 扩展（薄探针）                                 │
│    ├─ pi.on(...) 订阅通知型事件                       │
│    ├─ before_provider_request 取 payload（只读）      │
│    ├─ 有界队列 + 丢弃计数（D5）                       │
│    └─ 批量 HTTP POST 到 127.0.0.1:4173               │
└───────────────────────┬──────────────────────────────┘
                        │ 回环
┌───────────────────────▼──────────────────────────────┐
│ Next.js 服务（127.0.0.1:4173，Node Runtime）          │
│                                                      │
│  POST /api/ingest      接收批量事件，upsert 入库       │
│  GET  /api/sessions    会话列表                        │
│  GET  /api/session     单会话时间线（一次取全）        │
│  GET  /api/detail      行详情（按需取全文）             │
│  GET  /api/stream      SSE 推送                        │
│                                                      │
│  node:sqlite（~/.pi-observer/observer.db）             │
│    sessions / runs / turns / tool_calls /             │
│    llm_requests / events / probe_status / messages    │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│ 浏览器：单页（左侧项目 / 会话，右侧时间线）            │
└──────────────────────────────────────────────────────┘
```

数据流有三条，互不混淆：

1. **写**：只有 Next.js 服务写看板库。
2. **读**：页面只读看板库；内容只有一份，就在 `messages.payload`。
3. **实时**：探针推送 → 服务入库 → SSE → 浏览器；正文另有一条路——服务端每秒读会话文件补进 `messages.payload`。

---

## 7. 探针设计

### 7.1 生命周期

| 阶段 | 约束 |
|:--|:--|
| 工厂函数 | 只注册 handler 与命令，**不启动进程、socket、watcher、定时器** |
| `session_start` | 建立队列、定时器、读取配置与令牌 |
| `session_shutdown` | 幂等关闭：清空队列、停止定时器、最后尝试一次发送 |
| 重载 | 重载会替换运行时；关闭逻辑必须幂等，不得复用旧状态 |

### 7.2 只读约束

- 所有 handler 返回 `undefined`。
- 每个 handler 主体包在 `try/catch` 里，异常只记录到本地日志，绝不向 Pi 抛出（`tool_call` 的异常会阻断工具，其他钩子的异常行为不一，统一吞掉最安全）。
- **探针日志默认不进用户的终端**：探针跑在用户的 Pi 进程里，同一个 Pi 会打开很多项目，往 stderr 打一行就会在某个项目里突然出现一条与本项目无关的消息（真实经历：「批次被拒绝，已丢弃 7 条」）。所以日志默认只写 `data/probe.log`（与令牌同目录，超过 1 MB 轮转为 `.1`，只留最近两代）；要看到它用 `tail -f data/probe.log`，或设 `PI_OBSERVER_DEBUG=1` 同时打到 stderr。
- 不调用 `pi.appendEntry()`、`pi.sendMessage()`、`pi.sendUserMessage()`、`pi.setActiveTools()` 等任何写或改的 API。
- 不改 `event` 上的对象。

### 7.3 正文只有一条路径

协议 v3 起，探针**不推正文**：

- `message_start` / `message_update` / `message_end` 不订阅，也不再推送。
- 正文、思考、工具参数与结果，全部来自会话文件；服务端在会话进行中每秒读一次文件，把新条目写进 `messages.payload`。
- 探针只推文件里没有的信息：运行状态、工具起止、请求与响应、模型与思考等级的选择。

这样做的直接后果：**同一份内容在库里只有一份**。实时事件与文件不会各存一份、也不会不一致；代价是生成中的文字要等文件写完才看得到（界面显示"生成中"占位）。

> 旧版探针（协议 v2）会推 `message_update` 进度快照与 `message_end` 全文。服务端已升级到 v3，**旧探针的批次会被整批拒绝**，需要重新加载探针。

### 7.4 有界队列（D5）

### 7.4 有界队列（D5）

| 项 | 取值 |
|:--|:--|
| 条数上限 | 2,000 条记录 |
| 总字节上限 | 64 MB |
| 单条上限 | 512 KB，超出截断并打标 |
| 溢出策略 | 丢最旧，累加 `dropped_count` |
| 上报 | 每次请求带上累计丢弃数；看板显示"已丢弃 N 条" |

### 7.5 推送与重试

- 协议：HTTP POST `/api/ingest`，请求头带 `x-observer-token`；批次带 `protocol: 3`，版本不符整批拒绝。
- 批量：默认 300 ms 或 50 条，先到者触发。
- 服务未启动：不阻塞、不崩溃；按指数退避重试（1s → 2s → 5s → 10s，上限 30s）。
- 响应非 2xx：按状态码分开处理（2026-10-22 修正）：
  | 状态 | 处理 | 理由 |
  |:--|:--|:--|
  | 5xx / 408 / 429 / 网络错误 | 退回队首 + 退避重试 | 服务端或网络暂时不行 |
  | 401 | 清除内存里缓存的令牌 + 退回队首 + 退避重试（首档 1s） | 服务端重新生成过令牌文件时，缓存的旧值会让每一批都失败；丢数据没有意义，重读令牌文件即可自愈 |
  | 404 / 405 | 退回队首 + 退避重试 | 路由不存在（探针指向了别的服务）或 dev 正在重编译该路由 |
  | 400 / 413 | 丢弃整批并计入 `dropped_count` | 形状 / 协议不对，或这批超过服务端 2 MB 上限，重发还是一样 |
- **一条坏记录会毒掉整批**：`parseBatch` 是整批校验，`records[N]` 有一个字段不合法就整批拒。所以探针所有发射点都先判会话存在，`session_id` 不会出现空串。
- **丢批时必须说得清**：`dropped_count` 只统计探针成功上报的那些批次；一旦探针的每一批都被拒，它就永远上报不了丢弃数，看板会显示 0。因此：
  - 探针侧日志给出批次指纹（记录种类顺序 + 最大单条体积），可对着服务端的 `records[N]` 定位；
  - 服务端把每条拒批的 `warn`（令牌校验失败 / 拒绝过大的批次 / 批次校验失败 + 原因）留在内存环形缓冲里，由 `/api/health` 的 `recent_problems` 带出，页面底部状态栏显示最近一条。不这样做的实测后果：探针终端显示「已丢弃 7 条」，看板 `dropped_count` 是 0，两边都看不出原因。
- 探针启动时先请求 `/api/health`，不可用则进入离线模式，只保留队列。

### 7.6 配置

| 变量 | 默认值 | 说明 |
|:--|:--|:--|
| `PI_OBSERVER_URL` | `http://127.0.0.1:4173` | 服务基地址（推送与健康检查） |
| `PI_OBSERVER_TOKEN_FILE` | `~/.pi-observer/token` | 令牌文件；不受 Pi 的 cwd 影响 |
| `PI_OBSERVER_BATCH_INTERVAL_MS` | `300` | 批量推送间隔 |
| `PI_OBSERVER_BATCH_SIZE` | `50` | 队列达到多少条立即推送 |
| `PI_OBSERVER_MAX_BATCH_RECORDS` | `200` | 单批最多条数 |
| `PI_OBSERVER_MAX_BATCH_BYTES` | `1572864` | 单批最多字节（服务端上限 2 MB，留余量） |
| `PI_OBSERVER_PAYLOAD_DIR` | `<令牌文件所在目录>/payloads` | 正文文件根目录；必须与服务端的数据目录一致 |
| `PI_OBSERVER_MAX_QUEUE_RECORDS` | `2000` | 队列条数上限 |
| `PI_OBSERVER_MAX_QUEUE_BYTES` | `67108864` | 队列字节上限 |
| `PI_OBSERVER_DEBUG_REQUESTS` | `0` | 每次模型请求往日志写一行采集摘要（字节数与写入的路径），默认关闭 |
| `PI_OBSERVER_DEBUG` | `0` | 同时把探针日志打到 stderr；默认只写 `data/probe.log` |

---

## 8. 看板自有库

### 8.1 驱动

`node:sqlite`（Node 内置）。要求 Node ≥ 24；本机为 v26.5.0。开启 WAL。

初始化顺序（顺序错了 `auto_vacuum` 不生效，需要补一次 `VACUUM`）：

1. 打开库：`new DatabaseSync(path, { timeout: 5000 })`；
2. 若要用增量回收，**先**设 `PRAGMA auto_vacuum = INCREMENTAL`；
3. `PRAGMA journal_mode = WAL`；
4. `PRAGMA synchronous = NORMAL`；
5. 建表与索引（`schema.sql`）；
6. 迁移：读写 `PRAGMA user_version`。

连接只在服务端使用（route handler / server 组件），并挂在 `globalThis` 上避免开发态热重载重复打开；不得出现在客户端组件里。技术细节与实测见 `docs/tech-stack.md` §4、附录 B。

### 8.2 表结构

**sessions**

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `session_id` | TEXT PK | JSONL 头部的 `id` |
| `cwd` | TEXT | 工作目录 |
| `file_path` | TEXT UNIQUE | JSONL 绝对路径 |
| `parent_session` | TEXT NULL | 分叉来源 |
| `version` | INTEGER | 会话格式版本 |
| `name` | TEXT NULL | 显示名 |
| `started_at` / `last_activity_at` | TEXT | ISO |
| `message_count` / `turn_count` / `tool_call_count` | INTEGER | 聚合 |
| `tokens_in` / `tokens_out` / `cache_read` / `cache_write` | INTEGER | 聚合 |
| `cost` | REAL | 聚合 |
| `state` | TEXT | `active` / `idle` / `ended` |
| `source` | TEXT | `backfill` / `live` / `merged` |
| `last_reconciled_at` | TEXT NULL | 最近一次对账时间 |

**runs**（因为 `turnIndex` 每次运行归零，必须有这一层）

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `id` | INTEGER PK | |
| `session_id` | TEXT | |
| `run_seq` | INTEGER | 会话内自增；跨 Pi 进程由会话游标继续 |
| `started_at` / `ended_at` | TEXT | |
| `outcome` | TEXT NULL | `completed` / `aborted` / `error` |

约束：`UNIQUE(session_id, run_seq)`。

**turns**

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `id` | INTEGER PK | |
| `session_id` | TEXT | |
| `run_seq` | INTEGER | |
| `turn_index` | INTEGER | 运行内序号 |
| `message_entry_id` | TEXT UNIQUE | 来自 `turn_end`，持久且稳定 |
| `started_at` / `ended_at` | TEXT | |
| `stop_reason` / `thinking_level` | TEXT | |
| `assistant_message` | TEXT | 最终消息 JSON（v3 起不再写：正文以 `messages.payload` 为准） |
| `tool_results` | TEXT | 结果 JSON 数组（v3 起不再写） |
| `tokens_in` / `tokens_out` | INTEGER | 来自消息 `usage` |
| `cache_read` / `cache_write` | INTEGER NULL | 来自消息 `usage`（v3 起独立成列） |
| `cost` | REAL | 来自消息 `usage` |

约束：`UNIQUE(session_id, message_entry_id)`。

**tool_calls**

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `tool_call_id` | TEXT PK | 来自事件 |
| `session_id` | TEXT | |
| `parent_tool_call_id` | TEXT NULL | 嵌套调用 |
| `tool_name` | TEXT | |
| `args` | TEXT | v3 起不再写：参数在助手条目的 `toolCall.arguments` 里 |
| `result` | TEXT | v3 起不再写：结果在 toolResult 条目里 |
| `partial_result` | TEXT | 进行中的部分结果（v3 起不再写） |
| `is_error` | INTEGER | |
| `duration_ms` | INTEGER NULL | |
| `started_at` / `ended_at` | TEXT | |
| `run_seq` / `turn_index` | INTEGER NULL | 工具执行时所在的运行 / Turn（用于按 Turn 筛选与详情关联） |
| `entry_id` | TEXT NULL | 助手消息条目 id（参数所在；由文件同步器补写） |
| `result_entry_id` | TEXT NULL | toolResult 条目 id（结果所在；由文件同步器补写） |

**存储去重（v3 的核心约定）**：正文、思考、工具参数与结果都只在 `messages.payload` 里存一份。`turns` 与 `tool_calls` 只留标量、时间与指向 `messages` 的引用；查询时按 `entry_id` / `result_entry_id` join 出来。旧行的 `args` / `result` / `assistant_message` 仍在（7 天保留期内可查），查询用 `COALESCE` 回退。

**llm_requests**

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `id` | INTEGER PK | |
| `session_id` | TEXT | |
| `request_seq` | INTEGER | 会话内自增 |
| `provider` / `api` / `model` | TEXT | 优先取 `ctx.model`（provider / api / id），请求体里的 `model` 兜底 |
| `payload_path` | TEXT | 完整请求体的相对路径（`request/<会话>/<序号>.json`）；正文不落库 |
| `payload_bytes` | INTEGER | 正文原始字节数 |
| `status` | INTEGER NULL | 响应状态 |
| `response_headers` | TEXT NULL | 响应头（体积小，留在库里） |
| `correlation` | TEXT | `serial_assumed` |
| `created_at` | TEXT | 请求开始时间 |
| `run_seq` | INTEGER NULL | 请求发生时所在的运行（M3-3 起写入；旧行为 NULL） |
| `turn_index` | INTEGER NULL | 请求发生时所在的 Turn（与 `run_seq` 一起关联 `turns` 取 token / 成本） |

约束：`UNIQUE(session_id, request_seq)`。

三条落地约定（M3 → M4）：

- 正文**不落库也不截断**：探针把完整请求体写成文件（`~/.pi-observer/payloads/request/<会话>/<序号>.json`），批次里只带相对路径与原始字节数。文件是**原样的**（不脱敏），权限 0600、目录 0700。
- `request_seq` 与 `run_seq` 由探针按会话维护，游标写在 `~/.pi-observer/session-cursor/<会话哈希>.json`；Pi 进程退出后用 `--resume` 打开同一会话时接着上次的序号，不会从 1 重置覆盖旧记录或旧运行。本地游标缺失时（第一次跑新版本、换了数据目录），探针从 `GET /api/sessions/:id/cursor` 取库里已用到的最大序号种子化。
- 请求开始时写正文路径（状态码为空），`after_provider_response` 到达时用同一 `(session_id, request_seq)` 补 `status` / `response_headers`；更新记录不带路径字段，服务端不会用空值覆盖。按顺序关联（`correlation = serial_assumed`）。

**events**（时间线）

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `id` | INTEGER PK | |
| `event_id` | TEXT UNIQUE | 探针生成，用于幂等 |
| `session_id` | TEXT | |
| `layer` | TEXT | `session` / `agent` / `tool` / `provider` |
| `event_type` | TEXT | 事件名 |
| `payload_path` | TEXT | 完整事件正文的相对路径；正文不落库 |
| `payload_summary` | TEXT | 截短后的骨架（长字符串截到 200 字符、数组截到 50 项），时间线取标签用 |
| `occurred_at` | TEXT NULL | 事件自带时间 |
| `received_at` | TEXT | 服务端接收时间 |

**probe_status**（单行）

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `id` | INTEGER PK | 固定为 1 |
| `last_seen_at` | TEXT | 最近一次推送 |
| `dropped_count` | INTEGER | 累计丢弃 |
| `queue_depth` | INTEGER | 上报时的队列深度 |
| `probe_version` | TEXT | |

**messages**（会话文件里的每一条条目，见 §9.1）

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `id` | INTEGER PK | |
| `session_id` | TEXT | |
| `entry_id` | TEXT | 条目的 `id`；极少数没有 id 的条目用 `#line:<行号>` 兜底 |
| `parent_id` | TEXT NULL | 消息树的边 |
| `kind` | TEXT | 条目的 `type`：`message` / `model_change` / `thinking_level_change` / `usage` / `compaction` / `context_edit` / `branch_summary` / `custom` / `custom_message` / `label` / `session_info` |
| `role` | TEXT NULL | 只有 `message` 条目有：`user` / `assistant` / `system` / `toolResult` |
| `timestamp` | TEXT NULL | 条目自带时间 |
| `entry_index` | INTEGER | 条目在文件里的行号（同一秒的条目靠它排序） |
| `text` | TEXT NULL | 可读摘要：`message` 是正文，其他类型是一行说明；截到 2 KB |
| `payload_path` | TEXT NULL | 完整条目 JSON 的相对路径（`message/<会话>/<条目>.json`）；正文不落库 |
| `payload_summary` | TEXT NULL | 截短后的骨架（长字符串截到 200 字符、数组截到 50 项）；工具参数与结果从这里 join 出来 |

约束：`UNIQUE(session_id, entry_id)`。

**jsonl_files**（会话文件的读取进度，见 §9.1）

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `path` | TEXT PK | JSONL 绝对路径 |
| `session_id` | TEXT NULL | 头部声明的 id |
| `size` / `mtime_ms` | INTEGER | 上次读取**之前**看到的大小与修改时间 |
| `entry_count` | INTEGER | 该会话已入库的条目数（排查用） |
| `last_read_at` | TEXT | |

### 8.3 键与写入语义

| 表 | 唯一键 | 写入方式 |
|:--|:--|:--|
| `events` | `event_id` | `INSERT OR IGNORE` |
| `turns` | `message_entry_id` | `INSERT ... ON CONFLICT DO UPDATE` |
| `tool_calls` | `tool_call_id` | `INSERT ... ON CONFLICT DO UPDATE` |
| `llm_requests` | `(session_id, request_seq)` | 同上 |
| `sessions` | `session_id` | 同上 |
| `runs` | `(session_id, run_seq)` | 同上 |
| `messages` | `(session_id, entry_id)` | 同上（回填写入） |
| `jsonl_files` | `path` | 同上（回填的读取进度） |

### 8.4 写入策略

- 单条消息或单次工具调用只保留一行，流式过程用 upsert 更新。
- 探针批量推送，服务在一个事务里写完整批。
- WAL 模式；`node:sqlite` 连接放在 `globalThis` 上，避免 Next.js 热重载重复打开。
- 每批写完再触发 SSE，保证页面看到的顺序与库一致。

### 8.5 索引

```sql
CREATE INDEX idx_events_session_time ON events(session_id, received_at);
CREATE INDEX idx_events_groups       ON events(session_id, run_seq, turn_index, id);
CREATE INDEX idx_events_type         ON events(event_type);
CREATE INDEX idx_events_received     ON events(received_at);
CREATE INDEX idx_turns_session       ON turns(session_id, run_seq, turn_index);
CREATE INDEX idx_tools_session       ON tool_calls(session_id, started_at);
CREATE INDEX idx_requests_session    ON llm_requests(session_id, request_seq);
CREATE INDEX idx_requests_created    ON llm_requests(created_at);
CREATE INDEX idx_sessions_activity   ON sessions(last_activity_at DESC);
CREATE INDEX idx_messages_session    ON messages(session_id, entry_index);
CREATE INDEX idx_messages_tree       ON messages(session_id, parent_id);
CREATE INDEX idx_messages_kind       ON messages(session_id, kind);
CREATE INDEX idx_jsonl_files_session ON jsonl_files(session_id);
```

### 8.6 空间与清理

**不自动删数据**（2026-10-23 决定，取代原来的 7 天保留期）：

| 数据 | 处理 |
|:--|:--|
| `~/.pi-observer/payloads/` 里的正文文件 | 不自动删。容量由使用者自己控制：设置页能看到占用，变大了自己导出或删对应会话的目录 |
| `sessions` / `runs` / `turns` / `tool_calls` / `messages` / `events` / `llm_requests` | 不自动删 |
| `jsonl_files` | 不清理（读取进度，一行几十字节） |

理由：自动删除会让人以为数据还在，其实早就没了。改成「看得见占用、由人决定删不删」。

唯一还自动做的是**空间回收**：

- 每天执行一次 `VACUUM`，回收删除留下的空间；**`VACUUM` 之后必须跟一次 `PRAGMA wal_checkpoint(TRUNCATE)`**，否则 WAL 占用的磁盘不释放（实测：155 MB 的库只 `VACUUM` 后主库仍是 155 MB，补 checkpoint 后才归零）。
- 回收只动看板自己的库与正文目录，不动 `~/.pi/agent/sessions/` 下的原始会话文件。

---

## 9. 历史回填与实时拼接

### 9.1 回填

- 触发：
  - 服务启动时扫描一次（`src/instrumentation.ts`，只扫 `.jsonl`）；
  - 进入会话页面时补读（库里没有该会话、或文件在启动扫描之后又长了）；
  - `POST /api/backfill` 可手动触发（写接口，与 `/api/ingest` 一样要令牌；`?session=<id>` 只补一个）。
- 范围：`~/.pi/agent/sessions/` 下所有会话目录，含子目录。
- 内容：
  - `messages`：文件里的**每一条**条目都入库，用 `kind` 区分类型（`message` / `model_change` / `thinking_level_change` / `compaction` / …），`parent_id` 保留消息树的边；
  - `sessions`：从头部取 `session_id` / `cwd` / `version` / `parent_session` / `started_at`，并汇总 token、成本、计数；
  - `turns`：每个助手条目一个 turn（持久键 `message_entry_id`），token 与成本取自该条目的 `usage`，`tool_results` 取自它的工具结果子条目；
  - `tool_calls`：调用参数来自助手条目里的 `toolCall` 部分，结果 / 是否出错 / 耗时来自对应的工具结果条目；
  - `jsonl_files`：记下「读之前」的文件大小与修改时间，两者都没变就跳过，下次启动不必把历史重读一遍。
- 幂等：全部按持久键 upsert，与实时路径落到同一行（§9.3）。
- 不猜：
  - `runs` 不建行——run 的边界只存在于实时事件里（进程启动/结束），文件里没有；
  - `turns.run_seq` 回填时是占位值 `1`（整个文件当作一个 run），实时写入后用探针观察到的真值覆盖；`turn_index` 按文件顺序推导；
  - `sessions.state` 不推进（回填只把新会话标成 `idle`），`name` 不写；
  - 回填过的会话，`source` 由 `live` 变为 `merged`。

### 9.2 JSONL 解析规则（必须遵守）

1. **只消费以换行结尾的完整行**；末尾不完整片段留在缓冲区。
2. 每次读取前比较文件大小；**变小说明发生了整文件重写**（版本迁移、fork/clone），必须从头重读。
3. 用条目 `id` 去重，重写会让已消费的内容再次出现。
4. 遇到无法解析的行：跳过并记一条警告，不中断整个文件。
5. 不加文件锁。

重写的已知边界（M2-6 实测）：从头重读只做 upsert，**不会删除「已经不在文件里」的条目**——我们分不清「文件被截短」和「读取提前结束」，宁可多留也不误删。因此人为截短文件后，库里的条目数可能大于文件里的条目数；正常路径（Pi 只追加，或重写时保留全部条目）不会出现这种差异。

### 9.3 实时与历史的拼接

- **真相源是 JSONL**。实时事件只补文件里没有的信息：运行状态、工具起止、请求与响应、模型选择。
- **内容只有一份**：`messages.payload` 是正文的唯一副本。实时路径不再推正文，所以不存在「两处各存一份、可能不一致」的情况。
- **会话进行中每秒读一次文件**：`state=active` 的会话，服务端每秒扫一遍，文件有变化就把新条目写进 `messages.payload` 并广播 `session.updated`。文件没变时只做两次 stat，直接跳过。
- 同一会话的写入采用 upsert，键为持久 ID（`entry_id`、`toolCallId`），实时与回填会落到同一行。
- 会话结束（`agent_settled`）后 3 秒触发一次对账：重新读该文件，补齐实时丢失的部分，把 `source` 置为 `merged`。
- `run_seq` 跨 Pi 进程由会话游标继续（M3-3 起）；它只用于展示分组，持久键仍是条目 ID。

对账的落地约定（M2-5）：

- **触发**：`POST /api/ingest` 落库成功之后，从这一批记录里找出 `agent_settled` / `session_shutdown` 的会话，各自排一个 3 秒定时器（同一会话只留一个，新的重置计时）。定时器 `unref`，不拖住进程退出；进程正好在这 3 秒里退出，下次启动扫描会重新读文件，不会漏。
- **动作**：按已有的增量读取补读一次（文件没变就只做两次 stat），写 `sessions.last_reconciled_at = now` 并把 `source` 置为 `merged`（补读到新条目时 `backfillFile` 自己会置；文件自上次读过之后没变时它直接跳过、不碰 `source`，所以对账这一步必须自己写），然后广播一次 `session.updated`（带 `reconciled: true`）。
- **不写没核对过的时间**：会话没有文件（例如只在探针里出现过的测试会话）时返回 `found: false`、不写 `last_reconciled_at`，日志里记一条警告，不冒充「已对账」。
- **对账不动状态**：状态归探针管（`active` / `idle` 见 §11.1）；只有 `session_shutdown` 这一种情况由服务端推进到 `ended`。
- **幂等**：对账只是补读 + 写核对时间；重复对账不会产生重复条目（持久键 upsert），也不会把 `ended` 改回去。

### 9.4 多会话并发

- 每个会话目录独立处理，互不影响。
- 页面顶部显示"活跃会话数"，默认只对最近活跃的 N 个会话保持实时订阅展示。

---

## 10. API 与实时推送

| 方法 | 路径 | 用途 |
|:--|:--|:--|
| POST | `/api/ingest` | 探针批量写入，需要 `x-observer-token`；协议版本不符整批拒绝 |
| GET | `/api/health` | 探针可用性探测 |
| GET | `/api/sessions` | 会话列表（分页、按项目筛选） |
| GET | `/api/session?id=` | 单会话的时间线数据（消息、Turn、事件、工具、请求索引），一次取全 |
| GET | `/api/session?id=&v=` | 同上；带版本号时，库里没变只回 `{unchanged:true}`，供每秒轮询用 |
| GET | `/api/detail?session=&kind=&id=` | 行详情：正文 / 工具参数与结果 / 请求体与响应头 / 钩子入参 + 原始 JSON + 关联对象 |
| POST | `/api/backfill` | 手动触发回填，需要令牌 |
| GET | `/api/sessions/:id/cursor` | 会话游标（探针用来续接 `run_seq` / `request_seq`） |
| GET | `/api/stream` | SSE |

SSE 事件类型：`session.updated`、`probe.status`。每条只带最小标识，页面按需二次拉取，避免把大对象塞进 SSE。

---

## 11. 页面

`prototype/` 是**设计产物**：它定义视觉规范（配色、字号、间距、状态色语义）、信息结构与交互约定，也是本文档页面章节的图示。它不参与产品代码——产品界面按 Next.js + React 组件重写，只沿用其中的设计约定与 token 值。文件清单见 `prototype/README.md`。

### 11.1 左侧会话列表

- 按项目分组，按 `last_activity_at` 倒序。
- 每行：会话短 ID、项目路径、消息数、Turn 数、最后活跃时间、状态标记。
- 状态：`active`（最近有事件）、`idle`（`agent_settled` 且 60 秒无新事件）、`ended`（进程已退出）。

落地约定（M2-4 / R3）：

- **分组与排序**：按 `cwd` 分组，组内与组间都按 `last_activity_at` 倒序；没有它就用 `started_at`，两者都没有的排最后（同一时间用会话 id 兜底，保证顺序稳定）。`cwd` 为空归到「（未知工作目录）」。
- **每行的内容**：首条用户消息摘要、状态点、会话短 ID、模型 Turn 数、最后活跃时间。摘要取这一会话第一条 `role=user` 正文（≤120 字符，行内再按列宽省略）；没有用户消息就显示「文件里还没有用户消息」，不编一个标题。
- **搜索**：按摘要、项目路径、会话 ID、文件路径过滤（纯前端，不发请求）。
- **四种显示状态**：在上面的三种之外加 `unreconciled`（未对账），只用于 `source=backfill` 的会话——它们从没收到过实时事件，`sessions.state` 是回填写的默认值，文件里没有进程或 agent 的状态，所以**不冒充「空闲」**。会话再跑一轮、完成一次对账后 `source` 变 `merged`，就按真实状态显示；只回填过、之后再没跑过的会话会一直是「未对账」——这是诚实的上限，不推定为「已结束」。
- **规模**：列表最多取最近 500 个会话；库里更多时页头写明「只显示最近 N 个」，不静默截断。

### 11.2 单页时间线

看板是**一个页面**：左侧是项目 / 会话列表，右侧直接是选中会话的时间线。没有独立的会话详情页，也没有独立的消息树面板——分支信息降级为行上的标记与筛选。

顶部状态条：会话 ID、cwd、模型、状态、消息/Turn/工具计数、token、缓存与成本。

**时间线的落地约定（R3）**：

- **Turn 怎么分**：一个 UI Turn = 一条用户消息 + 到下一条用户消息之前的全部条目。数据库里的 `turns` 是模型 Turn（一个真实会话有 332 个模型 Turn、7 条用户消息），直接拿来分组会得到一堆没有用户提问的折叠块。首条用户消息之前的条目（会话头、系统提示、模型 / 思考等级切换）归入 `prelude`。
- **倒序与分页**：Turn 倒序（最新在上），默认只渲染最近 20 个，底部「加载更早」每次再加 20 个；打开停在顶部，不滚到底。
- **折叠**：Turn 默认折叠；会话进行中（`state=active`）的最后一个 Turn 自动展开一次，用户手动收起后不抢回来。
- **分组筛选**：顶部按消息 / 会话 / 运行 / 工具 / 模型 / 探针六组过滤，外加「思考」与「其它分支」两个开关。开关写 `localStorage`，下次打开沿用。
- **行内容**：用户 / 助手正文与思考、工具命令与结果预览、请求与响应两行、钩子事件、正在生成时的「生成中」占位。行尾的「⋯」打开行详情弹窗。
- **分支标记**：不在当前分支上的行标「其它分支」，默认隐藏，可用开关打开；父条目连不上的标「孤立」。
- **落盘快照**：时间线里只有已经写进文件的条目。正在生成的消息要等它落盘、下一次同步才出现。
- **不编造**：库里数据超过取数上限时，顶部如实说明「只显示了最近的一部分」。

**行详情弹窗**：三个标签页。

1. **内容**：文件行给正文、思考、工具参数与结果；请求行给概览（序号 / provider / api / model / payload 字节 / 响应状态 / token），弹窗里给出完整请求体与响应头；钩子事件给钩子入参。
2. **原始 JSON**：这一行对应的完整载荷。
3. **关联**：这一行挂着的钩子事件、工具与请求。

来源在标题上标清楚：文件行标「来自文件」，钩子行标「钩子事件」，请求行标「钩子记录」。

用量的落地约定（M3-5）：

- **会话级**：输入 / 输出 token 与成本来自 `turns` 行求和；缓存读取 / 写入来自助手消息的 `usage.cacheRead` / `usage.cacheWrite`。顶部状态条显示这五项。
- **Turn 级**：时间线每个 Turn 的头部显示该 Turn 的输入 / 输出 token 与成本；一个用户 Turn 下的多个模型 Turn 相加。
- **口径一致**：实时路径与文件回填都写同一张 `turns` 表，所以两种来源不会各算一套；与 Pi 导出的 `usage` 的逐会话对照见 `tools/acceptance/real-pi/tree-compare.mjs`。

### 11.3 主题

亮 / 暗两套主题，默认暗色。顶栏按钮或 `D` 键切换，选择写 `localStorage["pi-observer-theme"]`，首屏绘制前生效（不闪一下）。亮色背景是**中性灰**（不是暖白 / 米黄）。

### 11.4 探针状态

页脚显示：最近一次推送时间、队列深度、累计丢弃数。丢弃数大于 0 时高亮。

---

## 12. 配置与部署边界

| 项 | 值 | 说明 |
|:--|:--|:--|
| 监听地址 | `127.0.0.1` | 固定回环，不监听 `0.0.0.0` |
| 端口 | `4173` | 已确认。避开常用 3000 与 Pi 相关端口 |
| 数据库 | `~/.pi-observer/observer.db` | 与 Pi 数据完全分离；**放在工程外**，否则 dev 下会被 Turbopack 当成源码变化而反复重编译 |
| 会话目录 | `~/.pi/agent/sessions` | 可配置 |
| 运行数据目录 | `~/.pi-observer` | 库、令牌、正文文件、探针日志都在这里；**必须放在工程外**（见下） |
| 令牌 | `~/.pi-observer/token` | 首次启动生成，仅用于 `/api/ingest` |
| 运行时 | Node ≥ 24 | `node:sqlite` 要求 |

启动方式：

```bash
npm run dev     # 开发：next dev -H 127.0.0.1 -p 4173
npm run build   # 构建
npm run start   # 生产：next start -H 127.0.0.1 -p 4173
pi --extension /absolute/path/to/pi-observer/ext
```

注意：Next 的 `dev` 与 `start` 默认监听 `0.0.0.0`，所以 `-H 127.0.0.1` 必须写进 `package.json` 脚本，不能只在文档里说明。端口用 `-p` 传，因为 `PORT` 环境变量对 Next 不生效（HTTP 服务器早于 `.env` 加载）。

**运行数据目录必须在工程外**：Turbopack 会监听工程目录里的文件变化，而看板自己在往数据目录写正文、日志与 WAL
（探针每几秒就写一次）。放在仓库里的话，每次写入都触发一次重编译，dev 下页面不停整页重载——实测每秒 2~6 次。
放到 `~/.pi-observer/` 后，同一段时间内重编译次数为 0。

**不要在仓库里建 `data` 软链**：Turbopack 会跟随符号链接去监听目标目录，于是「放在工程外」等于没做。
实测：`data -> ~/.pi-observer` 时，往工程外写文件照样每秒触发十几次编译。

**另一个会引发整页重载的循环**：dev 下打开页面会触发一次按需编译，编译完 Turbopack 发出 HMR 消息，
浏览器收到后整页重载 → 又触发编译 → 循环。工程内文件稳定时这个循环自己会停；
但只要工程内有文件在变（比如探针往 `data/` 写正文），它就会一直转。
所以「工程内不放运行数据」既是性能问题，也是这个循环的开关。

---

## 13. 安全与隐私

| 风险 | 处理 |
|:--|:--|
| 请求 payload 含系统提示与全部历史 | 原样存在 `data/payloads/`（权限 0600）；界面默认折叠，需点击展开 |
| payload 含 `authorization`、`x-api-key` 等 | 按键名黑名单剔除；`before_provider_headers` 不订阅，从源头避免采集 headers |
| payload 体积大 | 单条 512 KB 上限，超出截断并标注；整条记录 7 天后清空正文 |
| 任意网页向本机接口写数据 | `/api/ingest` 要求令牌；读取接口只读且无副作用 |
| 局域网访问 | 只绑定 `127.0.0.1`；启动时校验监听地址 |
| 看板库被当作真相源 | 界面上所有实时数据标注来源；对账以 JSONL 为准 |

---

## 14. 里程碑与验收

### M1 骨架贯通

内容：Next.js 项目、`node:sqlite` 建表、探针推送、批量写入、SSE、页面显示原始事件流。

验收：

- 在真实 Pi 会话中发起一次请求，`turn_start` / `turn_end` / 工具事件在 2 秒内出现在页面。
- Pi 侧无可感知卡顿（连续两轮对话的响应时间与未装探针时相比偏差不超过 10%）。
- 强杀服务端 30 秒后重启，探针不崩溃；恢复后新事件继续入库；`probe_status.dropped_count` 可查。

### M2 历史与分支

内容：会话扫描与回填、JSONL 解析、当前分支判定、会话列表。

验收：

- 现有 2 个会话全部可见，消息数与 Pi 自带的 `/tree` 一致。
- 在 Pi 正在写入时读取，不出现整文件解析失败。
- 人为把会话文件截短（模拟重写），回填逻辑检测到并重读，不产生重复条目。

### M3 请求与用量

内容：`before_provider_request` / `after_provider_response` 接入、请求正文落文件、请求与工具的取数、token 与成本汇总。

验收：

- 每次 `before_provider_request` 恰好 1 条记录；应用层再次发起的新请求（新 turn / 重发）会产生新序号，不覆盖旧记录。
  Pi 内部的 HTTP 重试发生在一次 before / after 之间，探针看不到每次尝试，只记一条（状态码取最终响应）；重试次数不可得。
- 记录里只有正文路径与字节数，完整请求体在正文文件里；`payload_bytes` 与触发时打印的原始长度一致。
- 正文文件权限 0600、目录 0700（原样保存，不脱敏）。
- 状态码与响应头可见。
- 时间线里请求与响应各占一行（`provider →` / `provider ←`）；行详情弹窗显示完整请求体、响应头、usage（含缓存读写）与关联的 run / Turn，并能「对比上一条」请求的逐行差异。
- 时间线里工具单独成行，显示工具名、参数预览、耗时与成功 / 失败；行详情弹窗显示完整参数、最终结果，并关联到助手条目与结果条目。
- 会话顶部显示输入 / 输出 token、缓存读取 / 写入与成本；时间线 Turn 头显示同一 Turn 的 token 与成本；与 JSONL 中 assistant 消息的 `usage` 求和一致。

### M3-6 单页重构（本轮）

内容：单页外壳、按用户消息分组的 Turn 行模型、倒序与分页、分组筛选、行详情弹窗、亮暗主题、每秒轮询的版本号判重。

验收：

- 只有一个页面：左侧项目 / 会话，右侧时间线；没有独立的会话详情页与消息树面板。
- Turn 倒序，默认最近 20 个，底部「加载更早」每次再加 20 个；打开停在顶部。
- Turn 默认折叠；进行中的 Turn 自动展开。
- 顶部分组筛选与亮暗主题的开关写 `localStorage`，刷新后保持。
- 每行「⋯」打开弹窗，内容 / 原始 JSON / 关联三个标签页。
- 活跃会话每秒轮询；库里没变时只回 `unchanged`，不重传整套数据。
- 协议 v3：探针不推正文；同一份内容在库里只有一份。

### M4 打磨

内容：筛选、状态判断、性能、保留清理。

验收：

- 10 万条 `events` 下，会话详情页首屏 P95 小于 500 ms。
- `agent_settled` 后 60 秒内状态从 `active` 转为 `idle`，不出现"永远生成中"。
- 清理任务在启动时执行：7 天前的 `events` 行被删除，7 天前的 payload 被清空为 `{"deleted":true}`；会话文件不受影响。

---

## 15. 风险与开放问题

| 风险 | 影响 | 处理 |
|:--|:--|:--|
| `turnIndex` 每次运行归零 | 单靠它无法做唯一键 | 已用 `runSeq` 分组、`messageEntryId` 作持久键 |
| 探针在流式中重启 | 正在生成的消息丢失尾部 | 对账从 JSONL 补齐；界面标注 |
| 请求与响应无共享 ID | 并发时可能错配 | 目前假设串行：同一时间只保留一个待响应请求，新的 `before_provider_request` 会放弃未响应的旧请求；界面标注 `serial_assumed` |
| JSONL 整文件重写 | 读取位置失效 | 大小变小即重读；用条目 ID 去重 |
| 同一条目 id 出现在两个会话文件里 | `turns`（`message_entry_id`）与 `tool_calls`（`tool_call_id`）的持久键是全局唯一，回填后到的那份会写到先到的那一行 | 实测 Pi 的 `newSession`（fork / clone，`parentSession` 记录血缘）只写一个新的 `session` 头部、不复制条目 id（`session-manager.js` 已核），所以正常路径不会发生；手工复制会话文件属于已知边界 |
| 正文体积与敏感内容 | 存储膨胀、泄露风险 | 正文存文件（目录 0700 / 文件 0600），不落库、不脱敏、不截断；**不自动清理**，占用在设置页可见，由使用者自己决定删不删 |
| Node 版本过低 | `node:sqlite` 不可用 | 启动时检查版本并给出明确错误 |
| Pi 升级导致事件契约变化 | 探针失效 | 记录所适配的 Pi 版本；升级后跑一遍 M1 验收 |
| 多会话并发 | 事件交错、页面混乱 | 按会话分组；默认只展示最近活跃的若干会话 |
| Next 大版本改变默认行为 | 例如默认监听地址、构建器、TS 配置被改写 | 锁 `16.4.x`；升级前跑一遍 M1 验收；监听地址永远显式写在脚本里 |

---

## 附录 A 验证依据

本 PRD 的数据来源与事件契约来自对 Pi 1.3.0 的实测与文档核对，证据与命令见：

- `docs/durable-feasibility.md`（V1–V23、H1–H5、D1–D6）

关键结论：

1. Pi 1.3.0 不存在 Durable 存储，CLI 从未依赖 `pi-durable`。
2. `turnIndex` 每次 `agent_start` 归零。
3. `message_update` 峰值 104.6 次/秒，事件携带全量快照。
4. 助手消息只在 `message_end` 落盘。
5. `before_provider_request` 返回 `undefined` 不会替换 payload；handler 抛错被 runner 捕获。
6. `agent_settled` 是正式终态，`agent_end` 不是。

## 附录 B 事件字段速查

**协议 v3 推的字段**（只推文件里没有的信息）：

| 事件 | 关键字段 |
|:--|:--|
| `turn_end` | `turnIndex`、`stopReason`、助手消息的 `usage`（token / 缓存 / 成本） |
| `tool_execution_start` | `toolCallId`、`toolName`、`parentToolCallId` |
| `tool_execution_end` | `toolCallId`、`isError`、`durationMs` |
| `before_provider_request` | `payload` |
| `after_provider_response` | `status`、`headers` |
| `agent_settled` | `aborted` |
| `session_tree` | `newLeafId`、`oldLeafId`、`summaryEntry` |

**v3 不再推的字段**（内容在会话文件里）：

| 事件 | 原字段 | 现在在哪 |
|:--|:--|:--|
| `message_start` / `message_update` / `message_end` | `message`、`assistantMessageEvent` | 会话文件的 `message` 条目 |
| `tool_execution_start` | `args` | 助手条目 `content` 里的 `toolCall.arguments` |
| `tool_execution_end` | `result` | toolResult 条目 |
| `tool_execution_update` | `partialResult` | 不再采集 |
