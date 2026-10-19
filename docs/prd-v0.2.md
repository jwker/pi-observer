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
| 流式写入 | 服务端缓冲 | 探针侧合并（D4），服务端 upsert |
| 驱动 | better-sqlite3 | `node:sqlite`（D1） |
| 历史解析 | 未定义 | 只消费完整行、检测重写、按 id 去重 |
| 探针约束 | 未写 | 独立一节，含队列上限与丢弃计数（D5） |
| 验收 | 无 | 每个里程碑有可验证的完成判据 |

### 0.1 已确认决策

| 编号 | 决策 |
|:--|:--|
| C1 | 端口 `4173` |
| C2 | 实时正文默认开启，可关闭 |
| C3 | 看板自有库用 `node:sqlite` |
| C4 | 不做会话删除、隐藏、重命名等写操作 |
| C5 | payload 存脱敏后的全文（方案 A） |
| C6 | payload 与事件只保留 7 天，到期自动清理，不设总量上限 |
| C7 | 代码与文档纳入 git 版本控制 |

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
| 会话、分支、消息全文 | 会话 JSONL | ✅ | 真相源 |
| token、成本、模型、provider、耗时、响应 ID | 会话 JSONL 的 assistant message | ✅ | 含 `usage.cost` 明细 |
| 生命周期事件 | 扩展事件 | ✅ | 实时 |
| 请求 payload | `before_provider_request` | ✅ | 需脱敏与体积上限 |
| 响应状态码与 headers | `after_provider_response` | ✅ | 不含响应 body |
| 响应正文 | `message_update` / `message_end` | ✅ | 流式增量或最终全文 |
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
- 响应正文通过 `message_update`（流式增量）与 `message_end`（最终全文）获得。

### 4.5 不可得与降级

| 数据 | 情况 | 处理 |
|:--|:--|:--|
| 响应 body 原始字节 | 钩子不提供 | 用消息内容重建，并在界面标注"由流式事件重建" |
| 请求的 wire 级字节 | 只有结构化 payload | 展示结构化 payload，标注"序列化前" |
| 请求与响应的强关联 | 没有共享请求 ID | 按会话内顺序配对，标注"按顺序关联" |
| 探针启动前的事件 | 未订阅 | 回填兜底，界面标注"仅历史" |

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
| `turn_start` | Turn | 通知 | ✅ | `turnIndex`、`timestamp` |
| `turn_end` | Turn | 转换 | ✅ | `turnIndex`、`messageEntryId`、`toolResultEntryIds`、`message`、`toolResults` |
| `message_start` | Message | 通知 | ✅ | 消息角色与初始内容 |
| `message_update` | Message | 通知 | ✅（可关） | 最新快照与增量类型 |
| `tool_execution_start` | Tool | 通知 | ✅ | `toolCallId`、`toolName`、`args`、`parentToolCallId` |
| `tool_execution_update` | Tool | 通知 | ✅ | `partialResult` |
| `tool_execution_end` | Tool | 通知 | ✅ | `result`、`isError`、`durationMs` |
| `before_provider_request` | Provider | 转换 | ✅ | `payload` |
| `after_provider_response` | Provider | 通知 | ✅ | `status`、`headers` |
| `model_select` | Model | 通知 | ✅ | 新模型与来源 |
| `thinking_level_select` | Model | 通知 | ✅ | 新等级 |

说明：`turn_end` 是转换型事件，但它是 `messageEntryId` 的唯一来源，因此必须订阅；handler 返回 `undefined` 即为空操作。

---

## 6. 架构

```text
┌──────────────────────────────────────────────────────┐
│ Pi 进程（终端）                                       │
│                                                      │
│  probe 扩展（薄探针）                                 │
│    ├─ pi.on(...) 订阅通知型事件                       │
│    ├─ before_provider_request 取 payload（只读）      │
│    ├─ 流式事件就地合并（D4）                          │
│    ├─ 有界队列 + 丢弃计数（D5）                       │
│    └─ 批量 HTTP POST 到 127.0.0.1:4173               │
└───────────────────────┬──────────────────────────────┘
                        │ 回环
┌───────────────────────▼──────────────────────────────┐
│ Next.js 服务（127.0.0.1:4173，Node Runtime）          │
│                                                      │
│  POST /api/ingest      接收批量事件，upsert 入库       │
│  GET  /api/sessions    读库                            │
│  GET  /api/.../tree    读 JSONL（回填/校验）           │
│  GET  /api/stream      SSE 推送                        │
│                                                      │
│  node:sqlite（./data/observer.db）                     │
│    sessions / runs / turns / tool_calls /             │
│    llm_requests / events / probe_status               │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│ 浏览器：会话列表 / 消息树 / 时间线 / 请求详情          │
└──────────────────────────────────────────────────────┘
```

数据流有三条，互不混淆：

1. **写**：只有 Next.js 服务写看板库。
2. **读**：页面只读看板库；消息树可以从 JSONL 现解析或缓存。
3. **实时**：探针推送 → 服务入库 → SSE → 浏览器。

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
- 不调用 `pi.appendEntry()`、`pi.sendMessage()`、`pi.sendUserMessage()`、`pi.setActiveTools()` 等任何写或改的 API。
- 不改 `event` 上的对象。

### 7.3 流式合并（D4）

高频事件不逐条转发。探针维护一张合并表：

- 键：`session_id + runSeq + turnIndex`。
  `runSeq` 在每次 `agent_start` 自增，因为 `turnIndex` 每次运行都会归零。
- 值：最新消息快照、`updateCount`、开始时间、当前字节数。
- `message_update`：覆盖快照、计数 +1，**只写内存**。
- 每 500 ms：把仍在进行中的记录作为进度快照推一次。
- `turn_end`：写入最终消息、`messageEntryId`、工具结果，出队并删除。
- `tool_execution_update` 同样处理，键用 `toolCallId`。

开关：`probe.liveText`（默认开启）。关闭后只处理 `message_start` 与 `turn_end`，看板显示"生成中"，消息结束再出全文。

### 7.4 有界队列（D5）

| 项 | 取值 |
|:--|:--|
| 条数上限 | 2,000 条记录 |
| 总字节上限 | 64 MB |
| 单条上限 | 512 KB，超出截断并打标 |
| 溢出策略 | 丢最旧，累加 `dropped_count` |
| 上报 | 每次请求带上累计丢弃数；看板显示"已丢弃 N 条" |

### 7.5 推送与重试

- 协议：HTTP POST `/api/ingest`，请求头带 `x-observer-token`。
- 批量：默认 300 ms 或 50 条，先到者触发。
- 服务未启动：不阻塞、不崩溃；按指数退避重试（1s → 2s → 5s → 10s，上限 30s）。
- 响应非 2xx：视为失败，记录一次，不重放已丢弃的记录。
- 探针启动时先请求 `/api/health`，不可用则进入离线模式，只保留队列。

### 7.6 配置

| 变量 | 默认值 | 说明 |
|:--|:--|:--|
| `PI_OBSERVER_ENDPOINT` | `http://127.0.0.1:4173/api/ingest` | 推送地址 |
| `PI_OBSERVER_TOKEN` | 读 `./data/token` | 会话令牌 |
| `PI_OBSERVER_LIVE_TEXT` | `1` | 是否推送流式正文 |
| `PI_OBSERVER_SNAPSHOT_MS` | `500` | 进度快照间隔 |
| `PI_OBSERVER_QUEUE_RECORDS` | `2000` | 队列条数上限 |
| `PI_OBSERVER_QUEUE_BYTES` | `67108864` | 队列字节上限 |

---

## 8. 看板自有库

### 8.1 驱动

`node:sqlite`（Node 内置）。要求 Node ≥ 24；本机为 v26.5.0。开启 WAL。

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
| `run_seq` | INTEGER | 探针内自增 |
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
| `assistant_message` | TEXT | 最终消息 JSON |
| `tool_results` | TEXT | 结果 JSON 数组 |
| `tokens_in` / `tokens_out` | INTEGER | 来自消息 `usage` |
| `cost` | REAL | 来自消息 `usage` |

约束：`UNIQUE(session_id, message_entry_id)`。

**tool_calls**

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `tool_call_id` | TEXT PK | 来自事件 |
| `session_id` | TEXT | |
| `parent_tool_call_id` | TEXT NULL | 嵌套调用 |
| `tool_name` | TEXT | |
| `args` | TEXT | |
| `result` | TEXT | 最终结果 |
| `partial_result` | TEXT | 进行中的部分结果 |
| `is_error` | INTEGER | |
| `duration_ms` | INTEGER NULL | |
| `started_at` / `ended_at` | TEXT | |

**llm_requests**

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `id` | INTEGER PK | |
| `session_id` | TEXT | |
| `request_seq` | INTEGER | 会话内自增 |
| `provider` / `api` / `model` | TEXT | 从 payload 提取 |
| `payload` | TEXT | 脱敏后的 JSON；7 天后清空为 `{"deleted":true}` |
| `payload_bytes` | INTEGER | 原始大小 |
| `payload_truncated` | INTEGER | 是否截断 |
| `status` | INTEGER NULL | 响应状态 |
| `response_headers` | TEXT NULL | 脱敏后的 headers |
| `correlation` | TEXT | `serial_assumed` |
| `created_at` | TEXT | |

约束：`UNIQUE(session_id, request_seq)`。

**events**（时间线）

| 列 | 类型 | 说明 |
|:--|:--|:--|
| `id` | INTEGER PK | |
| `event_id` | TEXT UNIQUE | 探针生成，用于幂等 |
| `session_id` | TEXT | |
| `layer` | TEXT | `session` / `agent` / `turn` / `message` / `tool` / `provider` |
| `event_type` | TEXT | 事件名 |
| `payload` | TEXT | 原始事件 JSON |
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

### 8.3 键与写入语义

| 表 | 唯一键 | 写入方式 |
|:--|:--|:--|
| `events` | `event_id` | `INSERT OR IGNORE` |
| `turns` | `message_entry_id` | `INSERT ... ON CONFLICT DO UPDATE` |
| `tool_calls` | `tool_call_id` | `INSERT ... ON CONFLICT DO UPDATE` |
| `llm_requests` | `(session_id, request_seq)` | 同上 |
| `sessions` | `session_id` | 同上 |
| `runs` | `(session_id, run_seq)` | 同上 |

### 8.4 写入策略

- 单条消息或单次工具调用只保留一行，流式过程用 upsert 更新。
- 探针批量推送，服务在一个事务里写完整批。
- WAL 模式；`node:sqlite` 连接放在 `globalThis` 上，避免 Next.js 热重载重复打开。
- 每批写完再触发 SSE，保证页面看到的顺序与库一致。

### 8.5 索引

```sql
CREATE INDEX idx_events_session_time ON events(session_id, received_at);
CREATE INDEX idx_events_type          ON events(event_type);
CREATE INDEX idx_turns_session        ON turns(session_id, run_seq, turn_index);
CREATE INDEX idx_tools_session        ON tool_calls(session_id, started_at);
CREATE INDEX idx_requests_session     ON llm_requests(session_id, request_seq);
CREATE INDEX idx_sessions_activity    ON sessions(last_activity_at DESC);
```

### 8.6 保留与清理

| 数据 | 保留 | 到期处理 |
|:--|:--|:--|
| `llm_requests.payload` / `response_headers` | 7 天 | 清空为 `{"deleted":true}`；行、模型、字节数、状态码等统计字段保留 |
| `events.payload` | 7 天 | 删除整行（该表只用于时间线） |
| `sessions` / `runs` / `turns` / `tool_calls` | 长期 | 随会话删除而删除 |

执行方式：

- 服务启动时执行一次，之后每小时一次。
- 判断依据：`llm_requests.created_at`、`events.received_at`。
- 只做时间判断，不设总量上限（已确认）。
- 每天执行一次 `VACUUM`，回收删除留下的空间。
- 清理只删除看板库中的副本，不动 `~/.pi/agent/sessions/` 下的原始会话文件。

---

## 9. 历史回填与实时拼接

### 9.1 回填

- 触发：服务启动时扫描一次；页面进入会话时若无记录则补读。
- 范围：`~/.pi/agent/sessions/` 下所有会话目录。
- 内容：解析 JSONL，写入 `sessions`、`turns`、`tool_calls`，并汇总 token、成本、计数。

### 9.2 JSONL 解析规则（必须遵守）

1. **只消费以换行结尾的完整行**；末尾不完整片段留在缓冲区。
2. 每次读取前比较文件大小；**变小说明发生了整文件重写**（版本迁移、fork/clone），必须从头重读。
3. 用条目 `id` 去重，重写会让已消费的内容再次出现。
4. 遇到无法解析的行：跳过并记一条警告，不中断整个文件。
5. 不加文件锁。

### 9.3 实时与历史的拼接

- **真相源是 JSONL**。实时事件用于"正在发生"的即时展示与活跃状态判断。
- 同一会话的写入采用 upsert，键为持久 ID（`messageEntryId`、`toolCallId`），实时与回填会落到同一行。
- 会话结束（`agent_settled`）后 3 秒触发一次对账：重新读该文件，补齐实时丢失的部分，把 `source` 置为 `merged`。
- 探针重启造成的 `runSeq` 断裂不影响持久数据：`run_seq` 只用于展示分组，持久键仍是条目 ID。

### 9.4 多会话并发

- 每个会话目录独立处理，互不影响。
- 页面顶部显示"活跃会话数"，默认只对最近活跃的 N 个会话保持实时订阅展示。

---

## 10. API 与实时推送

| 方法 | 路径 | 用途 |
|:--|:--|:--|
| POST | `/api/ingest` | 探针批量写入，需要 `x-observer-token` |
| GET | `/api/health` | 探针可用性探测 |
| GET | `/api/sessions` | 会话列表（分页、按项目筛选） |
| GET | `/api/sessions/:id/tree` | 消息树 |
| GET | `/api/sessions/:id/events` | 时间线（按层、类型、时间筛选） |
| GET | `/api/sessions/:id/turns` | Turn 列表 |
| GET | `/api/sessions/:id/llm-requests` | 请求列表与详情 |
| GET | `/api/stream` | SSE |

SSE 事件类型：`session.updated`、`turn.updated`、`tool.updated`、`request.updated`、`probe.status`。每条只带最小标识与版本号，页面按需二次拉取，避免把大对象塞进 SSE。

---

## 11. 页面

页面原型见 `prototype/`（多文件 HTML，可点击跳转，作为开发参考）。文件清单与改法见 `prototype/README.md`。

### 11.1 会话列表

- 按项目分组，按 `last_activity_at` 倒序。
- 每行：会话短 ID、项目路径、消息数、Turn 数、最后活跃时间、状态标记。
- 状态：`active`（最近有事件）、`idle`（`agent_settled` 且 60 秒无新事件）、`ended`（进程已退出）。

### 11.2 会话详情

顶部状态条：会话 ID、cwd、模型、状态、消息/Turn/工具计数、token 与成本。

左侧：消息树。从 JSONL 的 `id` / `parentId` 渲染，支持展开分叉、点击查看全文、高亮当前分支。

右侧三个视图：

1. **时间线**：Session / Agent / Turn / Message / Tool 事件按时间排列，Turn 作为可折叠容器。
2. **请求**：每次模型请求一行，展开看 payload（脱敏后）、状态码、headers、token 与成本；标注"序列化前"与"按顺序关联"。
3. **工具**：按名称、Turn、是否出错筛选，展示参数、结果、耗时。

实时正文：开启时，正在生成的助手消息以半透明样式逐段出现，每 500 ms 更新一次；关闭时显示"生成中…"。

### 11.3 探针状态

页脚显示：最近一次推送时间、队列深度、累计丢弃数。丢弃数大于 0 时高亮。

---

## 12. 配置与部署边界

| 项 | 值 | 说明 |
|:--|:--|:--|
| 监听地址 | `127.0.0.1` | 固定回环，不监听 `0.0.0.0` |
| 端口 | `4173` | 已确认。避开常用 3000 与 Pi 相关端口 |
| 数据库 | `./data/observer.db` | 与 Pi 数据完全分离 |
| 会话目录 | `~/.pi/agent/sessions` | 可配置 |
| 令牌 | `./data/token` | 首次启动生成，仅用于 `/api/ingest` |
| 运行时 | Node ≥ 24 | `node:sqlite` 要求 |

启动方式：

```bash
npm run dev     # 开发
npm run start   # 生产
pi --extension /absolute/path/to/packages/probe
```

---

## 13. 安全与隐私

| 风险 | 处理 |
|:--|:--|
| 请求 payload 含系统提示与全部历史 | 默认脱敏；界面默认折叠，需点击展开 |
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

### M2 历史与消息树

内容：会话扫描与回填、JSONL 解析、消息树渲染、会话列表。

验收：

- 现有 2 个会话全部可见，消息数与 Pi 自带的 `/tree` 一致。
- 在 Pi 正在写入时读取，不出现整文件解析失败。
- 人为把会话文件截短（模拟重写），回填逻辑检测到并重读，不产生重复条目。

### M3 请求面板

内容：`before_provider_request` / `after_provider_response` 接入、脱敏、请求列表与详情。

验收：

- 每次真实请求恰好 1 条记录；重试与重发会产生新记录，不覆盖旧记录。
- 记录中不含 `authorization` 或 API key。
- 记录的 `payload_bytes` 与触发时打印的原始长度一致；超过上限时 `payload_truncated` 为 1。
- 状态码与响应头可见。

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
| 请求与响应无共享 ID | 并发时可能错配 | 目前假设串行；出现并发时标注 `serial_assumed` 并在界面提示 |
| JSONL 整文件重写 | 读取位置失效 | 大小变小即重读；用条目 ID 去重 |
| payload 体积与敏感内容 | 存储膨胀、泄露风险 | 脱敏 + 单条 512 KB 截断 + 7 天到期清空；不设总量上限，磁盘占用按周衡量 |
| Node 版本过低 | `node:sqlite` 不可用 | 启动时检查版本并给出明确错误 |
| Pi 升级导致事件契约变化 | 探针失效 | 记录所适配的 Pi 版本；升级后跑一遍 M1 验收 |
| 多会话并发 | 事件交错、页面混乱 | 按会话分组；默认只展示最近活跃的若干会话 |

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

| 事件 | 关键字段 |
|:--|:--|
| `turn_end` | `turnIndex`、`messageEntryId`、`toolResultEntryIds`、`message`、`toolResults` |
| `tool_execution_start` | `toolCallId`、`toolName`、`args`、`parentToolCallId` |
| `tool_execution_update` | `toolCallId`、`partialResult` |
| `tool_execution_end` | `toolCallId`、`result`、`isError`、`durationMs` |
| `message_start` / `message_update` / `message_end` | `message`；`message_update` 另有 `assistantMessageEvent` |
| `before_provider_request` | `payload` |
| `after_provider_response` | `status`、`headers` |
| `agent_settled` | `aborted` |
| `session_tree` | `newLeafId`、`oldLeafId`、`summaryEntry` |
