# 方案 B：Durable 只读访问可行性验证

- 版本：v0.1
- 日期：2026-10-19
- 验证对象：Pi 1.3.0（安装时间 2026-10-17，managed install）
- 验证目的：确认 PRD §4.4「只读旁路打开 Durable SQLite」是否可行；不可行时找出真实可用的只读数据源

---

## 0. 结论

1. **本机不存在 PRD §4.4 描述的 Durable SQLite 存储。** Pi 1.3.0 没有任何 Durable 存储文件，`pi-coding-agent` 也不依赖任何 SQLite。
2. **Durable 是真实存在的独立运行时包，但没有被 Pi 装上。** `@earendil-works/pi-durable@1.3.0` 在 npm 上存在，描述为 "Durable conversation, task, and document runtime for Pi"，它出现在 Pi 的发布清单里，但不在 Pi 的依赖或安装产物中。
3. **即使 Durable 被启用，也不应该旁路读它的文件。** 它自带了官方的只读观察通道（`viewState()` / `watch()`），并且官方文档明确写着"One process owns a storage at a time; there is no cross-process locking"，用库打开存储还会触发数据库迁移（写操作）。
4. **PRD 的"四类数据"里，三类本来就在同一个会话 JSONL 文件里，只有请求/响应元数据需要扩展事件。** 而且 Pi 已经提供了稳定游标（`get_entries` 的 `since`）和现成的统计接口（`get_session_stats`）。
5. **Durable 不是一个可以打开的开关。** 它没有 CLI 参数、不是 Pi 扩展、也没有 bin；它是一个库，用来让你自己写宿主程序（`Harness.open()` + chord + pi-ai）。所以"装上 durable"不会让 pi CLI 产生任何可读数据。
6. **本机曾装过 pi-dashboard.app，现已卸载**，但留下了三类残留：`settings.json` 里 6 条指向已删除应用的包路径、`~/.pi/dashboard/` 的运行时状态、以及历史会话旁的 `*.meta.json`。pi-observer 是独立项目，不依赖它们。

---

## 1. 验证方法

| 手段 | 具体做法 |
|:--|:--|
| 安装产物检查 | 遍历 `~/.pi/agent/install/releases/1.3.0/node_modules`，检查依赖树、lockfile、bundle |
| 官方文档核对 | `pi-coding-agent/docs/` 下 extensions.md、session-format.md、rpc.md、rpc-commands.md、configuration.md、environment-variables.md |
| 类型定义核对 | `dist/core/extensions/types.d.ts`，事件名与字段以类型定义为准 |
| 真实数据抽样 | 解析 `~/.pi/agent/sessions/--*/` 下的 JSONL 与 `.meta.json` |
| 包内容检查 | 下载 npm tarball `@earendil-works/pi-durable@1.3.0`，检查 sqlite 存储的 schema 与打开方式 |

---

## 2. 验证项清单

| 编号 | 验证内容 | 结果 |
|:--|:--|:--|
| V1 | 本机是否存在 Durable SQLite 文件 | ❌ 不存在 |
| V2 | "Durable" 在 Pi 中的确切含义 | ⚠️ 有两种含义，均非存储引擎 |
| V3 | 会话文件位置、命名、路径编码规则 | ✅ 与 PRD 一致 |
| V4 | 会话文件格式与条目类型 | ✅ v3，12 种条目类型 |
| V5 | token 用量 / 成本 / 模型 / provider 是否可从文件获得 | ✅ 全部可得 |
| V6 | 请求 payload 是否可捕获 | ✅ 可得 |
| V7 | 响应状态与 headers 是否可捕获 | ✅ 可得；响应 body 不可得 |
| V8 | 响应内容如何重建 | ✅ 两条路径，语义不同 |
| V9 | 会话是否活跃如何判断 | ✅ 官方已有终态事件 |
| V10 | Turn / Tool 是否有稳定标识可做幂等键 | ✅ 已有 |
| V11 | 探针在 Pi 进程内的硬约束 | ⚠️ PRD 未写，必须补 |
| V12 | 是否有官方增量只读游标 | ✅ 有 |
| V13 | 是否有官方会话统计接口 | ✅ 有 |
| V14 | RPC 能否附加到已在运行的交互会话 | ❌ 不能，只能控制式启动 |
| V15 | pi-telemetry 能否作为看板数据源 | ❌ 不可用 |
| V16 | 是否存在多会话并发 | ⚠️ 存在，需决定采集范围 |
| V17 | 会话旁 `.meta.json` 由谁写入 | ⚠️ 由已卸载的 pi-dashboard 写入，属残留 |
| V18 | 读 JSONL 是否需要加锁 | ✅ 不需要 |
| V19 | Durable 是不是一个开关 | ❌ 不是开关，只能当库用 |
| V20 | 已卸载应用在 Pi 里的残留 | ⚠️ 6 条悬空包路径 |
| V21 | 看板自有库可用什么 SQLite 驱动 | ✅ `node:sqlite` 可用，无需原生模块 |
| V22 | pi-durable 怎么安装、CLI 是否依赖过它 | ✅ 只能当库装；CLI 从未依赖过 |
| V23 | 本机 Pi 版本是否过旧 | ✅ 1.3.0 即最新版 |

---

## 3. 详细结果

### 3.1 Durable 是否存在（V1、V2、V16）

- `find ~ -maxdepth 6 -name "session.sqlite*" -o -name "agent.sqlite*" -o -name "*durable*.sqlite*"`：0 命中。
- `pi-coding-agent` 的 `package.json` 与 `package-lock.json`：没有任何 SQLite 依赖。全树中唯一出现 `node:sqlite` 的地方是 bundle 里 undici 的可选 HTTP 缓存实现。
- 官方文档中 "durable" 只出现两次，语义都不是存储：
  - `docs/extensions.md:232`：`pi.appendEntry()` 对应「Durable data excluded from model context」，指不进入模型上下文的持久条目，实际落盘为 JSONL 里的 `custom` 条目。
  - `docs/rpc-commands.md:691`：entry id 可作为 durable cursor，用 `get_entries` 的 `since` 增量拉取。
- 发布清单 `install/releases/1.3.0/metadata.json` 列出了 `@earendil-works/pi-durable`，但它既不在 lockfile 中，也没有被安装。

结论：PRD §4.4 所假设的"独立的 session.sqlite / agent.sqlite 供只读旁路"在本机不成立。

### 3.2 Durable 的实际形态（V3）——如果它被启用

从 npm 包 `@earendil-works/pi-durable@1.3.0` 与 `@earendil-works/chord` 的内容看：

| 项目 | 事实 |
|:--|:--|
| 存储后端 | 三选一：SQLite 单文件（文档示例 `./session.sqlite`）、JSONL 目录、Cloudflare Durable Object |
| SQLite 模式 | WAL + `synchronous = NORMAL`；自动 checkpoint 默认 1000 页；`busyTimeout` 默认 5000ms |
| 驱动 | Node 内置 `node:sqlite` 的 `DatabaseSync`，不是 better-sqlite3 |
| 表 | `durable_schema`、`durable_metadata`、`record_ids`、`conversations`、`entries`、`tasks`、`submissions`、`documents`、`document_revisions` |
| PRD 概念映射 | commit 序列 → `entries` 的 `commitSeq`；Task 阶段 → `tasks` 的 `status`/`kind`/`abortRequested`/`background`；Submission → `submissions` 的 `requestId`/`status` |
| 打开 API | `openNodeSqliteStorage(path)`，可选项只有 `walAutoCheckpointPages`、`busyTimeoutMs`，**没有 readOnly 选项** |
| 打开副作用 | 库的打开流程会执行 `applySqliteMigrations()`，即写操作 |
| 官方原话 | "One process owns a storage at a time; there is no cross-process locking." |

对"只读旁路"的影响：

- 走库的 API 打开存储会写数据库，与只读承诺冲突。
- 绕过库、用 `new DatabaseSync(path, { readOnly: true })` 直接查表，理论上可行，但要自己跟随 schema 版本，并且 WAL 模式下只读连接在 `-shm` 不可写或需要恢复时会打开失败。
- 正确的做法是走库自带的只读观察 API，见 3.6。

#### 3.2.1 为什么它不是开关（V19）

| 检查 | 结果 |
|:--|:--|
| `pi --help` 里是否有 durable 相关参数 | 没有 |
| `pi-coding-agent` 的 CHANGELOG 是否有 durable 功能条目 | 没有（只有若干条用 "durable" 作形容词的无关修改） |
| `pi-durable` 的 `package.json` | 无 `bin`、无 `piConfig`、无 `pi` 字段 → 不是可执行程序，也不是 Pi 包 |
| `pi-durable` 的 dist 里是否有 Pi 扩展工厂 | 没有（无 `ExtensionAPI` / `pi.on()` / `registerTool`） |
| 谁依赖 `@earendil-works/chord`（durable 运行时） | 已安装的 7 个 `@earendil-works` 包里没有任何一个 |

它的用法是宿主自己起一个运行时：

```typescript
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } });
await root.submit({ type: "input", content: "..." }, context);
```

结论：Durable 是"另一条运行时路线"，与 pi CLI 并存但不共享会话数据。装上它不会让现有 pi 会话产生可读的 Durable 数据。

#### 3.2.2 版本时间线（回答"是不是我的版本太旧"）

| 事实 | 依据 |
|:--|:--|
| 本机装的是 1.3.0 | `~/.pi/agent/install/current-version` |
| 1.3.0 就是当前最新版（发布时间 2026-10-15） | registry `dist-tags.latest = 1.3.0` |
| `pi-durable` 也是 1.3.0，与 Pi 同批发布 | registry，创建于 2026-09-19 |
| **pi CLI 从来没有依赖过 `pi-durable`** | 逐个版本检查 `dependencies`，无任何版本包含它 |
| pi CLI 在 0.85.0 到 1.1.0 依赖 `@earendil-works/chord` | registry 逐版本检查 |
| pi CLI 在 **1.2.0 移除了 chord 依赖** | CHANGELOG：「Removed the dependency on `@earendil-works/chord`」 |
| `pi-agent-core` 在 0.85–0.99.2 依赖 chord，1.x 不再依赖 | registry；本机安装的 1.3.0 里 `pi-agent-core` 只依赖 `pi-ai` 和 `typebox` |
| `chord` 的定位 | "Typed host runtime for plugins, contracts, replicated state, and RPC over JSON links" |

所以：**版本不旧，方向刚好相反。** 1.3.0 是 pi CLI 最不涉及 Durable 的版本之一；0.85–1.1 那条线才有 chord/durable 运行时，1.2.0 起被现在的 JSONL 会话模型取代。

#### 3.2.3 怎么装（V22）

| 方式 | 结果 |
|:--|:--|
| `npm install @earendil-works/pi-durable` | 可行，装的是库，供你自己的程序 `import` |
| `pi install @earendil-works/pi-durable` | 不适用。它是 Pi 扩展吗？不是：没有 `bin`、没有 `piConfig`、没有扩展工厂，`pi install` 装的是扩展/资源包 |
| 通过配置打开 | 没有这个开关 |

装完之后，它不会自动接管 pi CLI 的会话；你要自己写一个宿主程序，用 `Harness.open()` 把自己的 agent 跑在它上面（见 3.2.1 的代码）。那时才会产生 Durable 数据，读取方式是 `viewState()` / `watch()`（见 3.6）。

### 3.3 真实可用的只读数据源（V4–V8、V12、V13、V18）

| 数据 | 来源 | 可得性 | 说明 |
|:--|:--|:--|:--|
| 会话列表与分支树 | 会话 JSONL 的 `id` / `parentId` | ✅ | v3 格式，支持就地分叉；目录编码规则与 PRD §4.1 一致 |
| 消息内容 | JSONL 的 `message` 条目 | ✅ | system / user / assistant / toolResult |
| token 用量、成本、模型、provider、api、耗时、响应 id | JSONL 的 assistant message | ✅ | 实测字段：`usage`（含 `cost` 明细）、`provider`、`model`、`api`、`durationMs`、`responseId`、`stopReason`、`thinkingLevel` |
| 请求 payload | 扩展事件 `before_provider_request` | ✅ | 字段为 `payload: unknown`，文档说明可替换 |
| 请求 headers | 扩展事件 `before_provider_headers` | ✅ | PRD 未列 |
| 响应状态与 headers | 扩展事件 `after_provider_response` | ✅ | 在响应流被消费前触发，不含 body，与 PRD 判断一致 |
| 响应流内容 | `provider_stream_event` 或 `message_update` | ✅ | 前者是归一化之前的解析后流事件，通知型、不持久化 |
| 每次请求实际发送的上下文 | `context`（不含系统消息）/ `context_with_system`（含系统消息） | ✅ | PRD 未列，是还原"这次到底发了什么"的直接来源 |
| 会话统计 | RPC `get_session_stats` | ✅ | 消息数、工具调用数、token、成本、上下文占用比例 |
| 增量条目 | RPC `get_entries` 的 `since` | ✅ | 官方称为 durable cursor，重启后仍有效 |
| 树与状态 | RPC `get_tree` / `get_state` | ✅ | `get_state` 含 sessionFile、isStreaming、isCompacting、messageCount |
| 遥测 | `@earendil-works/pi-telemetry` | ❌ | 规范写明是进程内诊断、非持久状态，禁止包含 prompt、工具参数、payload；`PI_TELEMETRY` 只控制安装/更新上报 |

### 3.4 与 PRD §4.2 事件清单的差异

| PRD 写法 | 实际情况 |
|:--|:--|
| `session_switch` | 不存在。只有 `session_before_switch`（可取消）；另有 `session_before_fork`、`session_before_compact`、`session_compact`、`session_compact_failed`、`session_tree`、`session_before_tree`、`session_info_changed` |
| `agent_end` 不是终点，需用静默窗口判断 | `agent_end` 确实不是终点，但官方已提供 `agent_before_settle`（可追加条目并请求一次续跑）与 `agent_settled`（终态，带 `aborted` 标志）。不需要自造静默窗口 |
| 用 `message_update` 重建响应 | 可行，但 `provider_stream_event` 更接近原始流（归一化之前），更适合做响应重建 |
| 未列出 | `before_provider_headers`、`context`、`context_with_system`、`model_select`、`thinking_level_select`、`user_bash`、`ui_prompt_start`/`ui_prompt_end`、`cache_warming_decision`、`mcp_servers_change` |
| `tool_call` 可拦截 | 正确；补充：`tool_call` handler 抛错会阻断工具执行（fail-safe 设计） |

### 3.5 幂等键（V10）

Pi 在事件里已经给出稳定标识，PRD 不需要自造索引：

| 来源 | 字段 |
|:--|:--|
| `turn_start` | `turnIndex`、`timestamp` |
| `turn_end` | `turnIndex`、`messageEntryId`、`toolResultEntryIds`、`message`、`toolResults` |
| `tool_execution_start` / `_update` / `_end` | `toolCallId`、`toolName`、`args`、`parentToolCallId`、`durationMs`、`isError` |
| `get_entries` | `since` 游标；返回的每条条目带 `id` |

含义：`turns` 表应以 `messageEntryId` 为键，`tool_calls` 表应以 `toolCallId` 为键，与 JSONL 中的条目 id 天然对齐。

### 3.6 若 Durable 启用，官方只读通道（替代 SQLite 旁路）

- `viewState()`：返回会话的结构视图（只读），每次相关提交后更新。包含 `entries`（当前活跃 transcript）、`docs["pi.live"]`（正在进行的生成：流式 partial、重试、deferred、工具调用与输出）、`docs["pi.inbox"]`、`docs["pi.usage"]`、`docs["pi.agent"]`、`docs["pi.provider"]`。
- `watch()`：同样的视图，外加每次提交的 Chord 操作；慢客户端最多保留 100 帧，超出后用最新整视图替换一帧，不重放。
- 进度提交默认最多每 100ms 一次，可用 `settings.progress` 调整。
- `harness.usage()`：整会话的 token 与成本，按 provider/model 和工具名分组。

结论：PRD §7.3 想要的"commit 序列、task 阶段、重放标记、entry 摘要"，正确来源是这套 API，而不是 SQLite 文件。

### 3.7 探针在 Pi 进程内的硬约束（V11）

来自 `docs/extensions.md`，PRD 目前没有：

1. Extension factory 内不得启动进程、socket、watcher、定时器；长生命周期资源要在 `session_start` 建立，在幂等的 `session_shutdown` 关闭。
2. `provider_stream_event` 的 handler 按流顺序被 await，慢 handler 会拖慢流消费。
3. `tool_call` 的 handler 失败会阻断工具执行。
4. `turn_end` 与 `agent_before_settle` 是"可操作边界"，返回 `continue: true` 会再发起一次模型请求；观察者必须什么都不返回。
5. `/reload` 会替换 extension runtime，旧状态不可复用。

### 3.8 已卸载的 pi-dashboard 留下的痕迹（V17、V20）

`/Applications/pi-dashboard.app` 已经不存在，也没有相关进程，但留下了三类残留：

| 残留 | 位置 | 影响 |
|:--|:--|:--|
| 悬空包路径 6 条 | `~/.pi/agent/settings.json` 的 `packages` 与 `dashboardPluginBridges` | `pi list` 会列出它们，路径已不存在 |
| 运行时状态 | `~/.pi/dashboard/`（server.lock、gateway-9999.sock、sessions 等） | 已无进程使用 |
| 会话旁的 `*.meta.json` | `~/.pi/agent/sessions/--*/` | 内容为 `source: "dashboard"`，含 `tokensIn`/`tokensOut`/`cost`/`contextTokens`/`contextWindow`/`status`/`live`/`firstMessage` 等；写入方已不在，只会变旧 |

**什么叫悬空包**：`settings.json` 的 `packages` 是一份路径清单，Pi 启动时按清单逐个加载。应用被卸载后，清单里的路径已经指向不存在的目录，条目还留着，这种"指向不存在位置的引用"就是悬空包。

实测行为：Pi 启动时**不报错、静默跳过**这些不存在的路径（`pi --mode rpc` 下 stderr 为 0 字节），所以它们可以一直留着而不被发现。只有 `pi list` 和 `/config` 会把它们显示出来。

对 pi-observer 的影响：

- `*.meta.json` **不能作为数据来源**，因为写入方已经不存在，字段会停留在应用卸载前的那一刻。
- pi-observer 是独立项目，通过 Pi 自己的接口和会话文件取数，不需要与任何第三方应用协调。

### 3.9 读一个正在增长的会话文件，正确规则是什么（H1，自测）

**写入方事实**（`dist/core/session-manager.js`）：

- 正常追加：`appendFileSync(file, JSON.stringify(entry) + "\n")`，一次调用写一条完整记录，行尾带换行。
- 首次落盘：`openSync(path, "wx")` 后把已有条目整文件写出。
- **存在整文件重写**：`_rewriteFile()` 用 `openSync(path, "w")` 截断后重写全部条目。触发场景有三个：打开一个显式指定的零字节会话文件、加载旧版本会话时的版本迁移（v1/v2 自动升级到 v3）、`/fork` 或 `/clone` 生成新会话。
- Pi 自己读文件时会跳过空白行和无法解析的行，并且在尾部行不完整时**追加一个换行来修复**。这说明"读到半行"在真实使用中会发生，但可以用规则规避。

**因此读取规则是**：

1. 只消费以 `\n` 结尾的行，末尾不完整片段留在缓冲区，等下一次读取再拼。
2. 每次读取前比较文件大小；大小变小说明发生了重写，必须整个重新读。
3. 用条目 `id` 去重，因为重写会让已消费的内容再次出现。
4. 不要对文件加锁，Pi 不会加锁，读方也不需要。

结论：不需要"边写边读会不会坏"这种人工观察，规则已经可以从写入方实现直接推导出来。

### 3.10 读增长中的会话文件，还要注意请求体量（H2，自测）

抽样一个真实会话（77 KB）：

| 项 | 字节数 |
|:--|:--|
| 整个会话文件 | 77,041 |
| 其中系统消息条目（系统提示 + 工具声明） | 52,319 |
| 其余全部条目合计 | 约 24,000 |

含义：单次模型请求的 payload 主要由系统提示和工具声明构成，体量在数十 KB 量级，其中不含用户隐私的固定内容占了大头。`before_provider_request` 采集到的 payload 需要一套脱敏与体积上限策略（例如默认只存结构、按需展开），不能无条件整份落库。

### 3.11 RPC 只读通道实测（V14）

在 `--no-session` 下启动 RPC 并只发读取命令，实测结果：

- `get_state` 返回完整模型信息（id、api、provider、baseUrl、cost、contextWindow、compat、thinkingLevelMap）、thinkingLevel、isStreaming、isCompacting、sessionId、messageCount。
- `get_session_stats` 返回消息数、工具调用数、tokens、cost、contextUsage。
- 整个过程没有产生 API 调用，没有写会话文件（`--no-session` 生效，已验证无新文件）。
- 局限：它是**控制式启动**，即必须由 pi-observer 拉起一个 pi 进程。它读不到用户自己终端里那个已经在跑的会话。

### 3.12 自有库用什么驱动（V21）

| 对比项 | `better-sqlite3` | `node:sqlite` |
|:--|:--|:--|
| 来源 | 第三方 npm 包，最新 13.0.3 | Node 内置模块 |
| 生态成熟度 | 周下载约 704 万，资料、示例、问答最多 | 较新，第三方资料少 |
| 安装 | 原生模块，需要预编译二进制或本地编译工具链 | 无需安装 |
| 本机可用性 | 未验证 | Node v26.5.0 实测 `require('node:sqlite')` 直接可用，无实验性警告 |
| 与 Pi 的关系 | 无关 | Pi 自己的 Durable 用的就是它 |
| 接口风格 | 同步，API 类似 `prepare().run()` | 同步，`DatabaseSync`，API 类似 |

判断：

- 论"主流程度"，`better-sqlite3` 明显更高。
- 论"对一个本地单人项目是否合适"，`node:sqlite` 已经够用，且省掉一个原生依赖；Pi 自己也在用它，遇到问题时能对着 Pi 的实现看。
- 这属于依赖选择，两种选择都不影响数据来源、架构和 PRD 其他内容。

### 3.13 message_update 的实测频率与探针缓冲策略（H3）

实测（探针 `probes/message-update-rate.ts`，一次短回复）：

```
message_update: 71 次 / 679 ms → 104.6 次每秒
```

这是短回复的峰值，长回答会持续数十秒。按 105 次每秒估算：

| 场景 | 量级 |
|:--|:--|
| 单个流式回答逐条落库 | 约 6,300 行 / 分钟 |
| Next 服务停 60 秒，探针按条排队 | 约 6,300 条待推送 |

结论与设计约束：

1. **逐条持久化不可行**，PRD §5.2 说的"内存缓冲后批量写"方向正确，但还不够。
2. **合并做在探针侧，而不是服务端**（详见下面的机制）。
3. 探针队列仍有界并带丢弃计数，作为兜底。
4. 浏览器侧不需要看到每个 token：SSE 按刷新节奏推送合并后的快照即可。

#### 3.13.1 合并机制（决策 D4）

**键**：`session_id + runSeq + turnIndex`。
`turn_start` 给出 `turnIndex`，但实测它在每次 `agent_start` 时被重置为 0（`agent-session.js:885`），所以同一个会话的多次运行会出现重复的 `turnIndex`。探针在 `agent_start` 时自增一个 `runSeq` 来区分运行。一个 turn 内只有一条正在流式的助手消息，因此这个组合键在整个流式过程中稳定可用，不需要提前知道消息条目 id。

**探针侧状态**：一张 `Map`，值形如：

```
{
  sessionId, turnIndex,
  latestMessage,      // 最新一次事件里的完整助手消息快照
  updateCount,        // 这条消息累计收到多少次 message_update
  startedAt, lastAt,
  bytes               // 当前快照大小，用于体积控制
}
```

**处理规则**：

| 时机 | 动作 |
|:--|:--|
| `turn_start` | 建键，初始化计数 |
| `message_update` | 覆盖 `latestMessage`，`updateCount += 1`。**同步写内存，不做任何 IO、不 await** |
| `message_end` / `turn_end` | 把这条记录标记为已完成，带上 `messageEntryId`，交给发送队列后从 Map 删除 |
| 定时器（约 200–500 ms） | 把仍在进行中的记录作为"进度快照"推一次，让看板能看到实时文本 |

同样的规则适用于 `tool_execution_update`：键用 `toolCallId`，值存最新的 `partialResult`。

**服务端规则**：按同一个键 **upsert**，不追加。所以每个助手消息在库里始终只有一行，行数等于消息数，与 token 数无关。

**为什么必须在探针侧做**：探针运行在 Pi 进程内，服务端可能整个下午都没启动。如果探针按原始事件排队，队列长度 = 流式时长 × 频率 × 停机时长，长时间回答会持续吃 Pi 进程的内存。按上面的键合并后，队列长度只与"同时在流式的消息条数"有关，停机一小时与停机一秒没有区别。

#### 3.13.2 队列上限取值（决策 D5）

| 项 | 取值 | 理由 |
|:--|:--|:--|
| 队列条数 | 2,000 条记录 | 一条记录对应一个消息或一次工具调用，不是一次事件；2,000 条相当于几千轮对话的余量 |
| 队列总字节 | 64 MB | 单条快照可能很大（长回答含代码），必须同时按体积封顶 |
| 单条记录上限 | 512 KB | 超出截断并打标记，避免一条巨型输出把内存吃掉 |
| 溢出策略 | 丢最旧，累加 `dropped_count` | 与"能取多少取多少"的产品定位一致，不阻塞 Pi |
| 计数上报 | 每次推送带上累计丢弃数 | 看板显示"已丢弃 N 条"，不假装数据完整 |

配合 D4 的合并，这些上限实际上是"极端情况兜底"，正常情况下队列里只有几条。

---

## 4. 待人工确认

已全部由我自测完成：H1（读增长文件的规则，见 3.9）、H2（请求体量，见 3.10）、H4（残留情况，见 3.8）。H3 使用实测数据（见 3.13）。

| 编号 | 事项 | 现状 |
|:--|:--|:--|
| H3 | `message_update` 的实际触发频率 | ✅ 峰值 104.6 次每秒 |
| H5 | Durable 是否会被后续 Pi 版本启用 | 无法预测，只能监控上游依赖变化 |

---

## 5. 对 PRD 的修改建议

| PRD 章节 | 修改 |
|:--|:--|
| §4.4 | **整节删除**（决策 D6）。Durable 运行时不在本机，保留该节会让人以为看板能展示并不存在的数据 |
| §4.2 | 删除 `session_switch`；补充 `agent_before_settle` / `agent_settled`；把"静默窗口"替换为 `agent_settled`；补全 session 层其余事件 |
| §4.3 | 补充 `before_provider_headers`、`context`、`context_with_system`、`provider_stream_event`；注明 payload 需要脱敏 |
| §5 | `turns` 用 `messageEntryId`、`tool_calls` 用 `toolCallId` 作为唯一键；`sessions` 统计可直接取 `get_session_stats`；解析器按 3.9 的规则只消费完整行；驱动使用 `node:sqlite` |
| §5.2 | 写入策略改为：探针侧按（会话 + 消息条目 id）合并流式事件，服务端按批落盘（依据见 3.13） |
| §6 | 补充探针不得在 factory 启动资源；说明 RPC 无法附加到已在运行的交互会话 |
| §7.3 | **整节删除**（与 D6 一致），页面改为三视图：消息树、生命周期时间线、模型请求 |
| 新增 | 增加一章说明持久化边界：只消费完整行、处理整文件重写、用条目 id 去重 |
| 清理 | 从 `settings.json` 移除 6 条指向已卸载应用的包路径（`pi remove` 或直接编辑） |

---

## 6. 决策记录

| 编号 | 决策 | 依据 |
|:--|:--|:--|
| D1 | 看板自有库使用 `node:sqlite` | 本机 Node 26.5.0 实测可用、无实验性警告；零依赖；Pi 自己也在用 |
| D2 | 清理 `settings.json` 里的悬空包路径 | 已执行：6 条全部移除，`packages` 现为 `[]`；`dashboardPluginBridges` 与 `_dashboardManagedPackages` 两个已卸载应用留下的键也已删除；`pi list` 输出 "No packages installed."；备份在 `~/.pi/agent/settings.json.bak-20261019-133743` |
| D3 | pi-observer 与任何第三方看板应用完全独立 | 用户确认；不共用接口、不共用文件 |
| D4 | 探针侧按（会话 + 运行序号 + `turnIndex`）合并流式事件后再推送，服务端按同一键 upsert | 见 3.13.1。`turnIndex` 每次 `agent_start` 归零，必须配一个运行序号 |
| D5 | 探针队列：2,000 条 / 64 MB / 单条 512 KB，溢出丢最旧并累加计数 | 见 3.13.2 |
| D6 | v0.2 删除 Durable 一节，不保留占位 | 用户决定；本机不存在 Durable 运行时，保留只会误导 |

---

## 7. 复现命令

```bash
# V1 查找 Durable 存储
find ~ -maxdepth 6 \( -name "session.sqlite*" -o -name "agent.sqlite*" \) 2>/dev/null

# V1 检查依赖
grep -o '"node_modules/@earendil-works/[^"]*"' \
  ~/.pi/agent/install/releases/1.3.0/package-lock.json | sort -u

# V2 文档中的 durable
grep -rn "durable" ~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/docs

# V4/V5 会话条目类型与 assistant 字段
python3 - <<'PY'
import json, glob, collections
p = sorted(glob.glob(__import__('os').path.expanduser('~/.pi/agent/sessions/--*/*.jsonl')))[0]
types, roles = collections.Counter(), collections.Counter()
for line in open(p):
    if not line.strip():
        continue
    e = json.loads(line)
    types[e.get('type')] += 1
    if e.get('type') == 'message':
        roles[e['message'].get('role')] += 1
print(p)
print(dict(types))
print(dict(roles))
PY

# V6/V7/V9/V10 事件定义
grep -n "before_provider_request\|agent_settled\|messageEntryId" \
  ~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts

# V3 Durable 包内容
curl -sL https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.3.0.tgz | tar -xz

# V19 是否是可执行程序或 Pi 包
python3 -c "import json;p=json.load(open('package/package.json'));print({k:p.get(k) for k in ('bin','piConfig','pi','main')})"
find package/dist -type f -name "*.js" | xargs grep -l "ExtensionAPI" | head   # 无输出 = 不是 Pi 扩展

# V20 残留检查
ls -ld /Applications/pi-dashboard.app        # 不存在
pi list                                      # 仍列出 6 条悬空路径

# V21 node:sqlite 可用性
node -e "const {DatabaseSync}=require('node:sqlite'); console.log(typeof DatabaseSync)"

# V14 RPC 只读通道（不产生 API 调用）
{ printf '{"id":"1","type":"get_state"}\n'; printf '{"id":"2","type":"get_session_stats"}\n'; sleep 6; } \
  | perl -e 'alarm 20; exec @ARGV' pi --mode rpc --no-session

# 3.9 写入方实现
grep -n "appendFileSync\|_rewriteFile\|openSync" \
  ~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js
```
