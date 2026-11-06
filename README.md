# pi-observer

Pi 会话文件的只读本地看板，外加一个把 provider 请求正文存进 iCloud 的探针。

它做两件事：

1. **把 Pi 的会话文件（JSONL）渲染出来**：消息、工具调用、用量、分支，都在页面上看。
2. **把每次 provider 请求的原始请求体存成文件**：文件放在 iCloud 的一个文件夹里，
   页面不读这些正文，只在对应的助手消息上显示一个唯一标识（就是文件名），
   拿着它就能在 Finder 或编辑器里找到那一份请求。

## 边界

- **只读 Pi 的东西**：不写 Pi 的任何文件，不调用 Pi 的写入接口，不改会话状态。
- **单用户、单机**：服务固定监听回环地址，不做账号体系，不做远程访问。
- **没有实时**：数据在打开页面或点「刷新」时读一次，不轮询、不推送。
- **没有数据库**：会话文件就是数据源，项目不建库、不入库、不维护状态。
- **不推定**：文件里没有的字段标「不可用」，不用默认值补齐。
- **不读请求正文**：探针写、本项目不读。请求正文想去哪儿看就去哪儿看。

## 怎么启动

要求 Node `>=24 <27`。网页版与桌面版各一套命令。

### 一、网页版

```bash
cd /Users/jiangjiang/Documents/host/pi-observer
npm install
npm start
```

`npm start` 会在没有构建产物时先构建一次（只构建一次），然后把服务跑起来；
日志第一行是实际地址，比如 `看板地址 http://127.0.0.1:4173`，直接打开它。
端口默认 `4173`，被占用时自动换一个空闲端口并打印实际地址；想指定就用
`PORT=4180 npm start`。

改代码的时候用开发模式：

```bash
npm run dev
```

两个命令跑的是同一个应用，功能一模一样。区别只有一个：开发模式带热更新，
改完刷新就生效；`npm start` 跑的是构建产物，代码改动要重新构建才生效
（`npm start` 发现源码比构建产物新时会提醒你跑一次 `npm run build`）。

### 二、桌面版（Electron 窗口）

网页版的页面装进一个 Electron 窗口里。四条命令，区别在于服务从哪来、要不要打包：

| 命令 | 服务从哪来 | 什么时候用 |
|:--|:--|:--|
| `npm run desktop:dev` | `next dev` | 改代码时：窗口里 Hot Reload，不用构建 |
| `npm run desktop:run` | 构建产物（standalone） | 本机跑桌面版：先构建，再从源码起窗口 |
| `npm run desktop:pack` | 同上 | 打成 `.app`（`desktop/out/`），可分发 |
| `npm run desktop:dmg` | 同上 | 打成 `.dmg`，可安装 |

前两条都在仓库根目录跑，不用进 `desktop/`；Electron 依赖没装时自动装一次。

后两条是真正的发布物：产物在 `desktop/out/`，`.app` 可以直接双击打开，
`.dmg` 可以装到「应用程序」里。两者默认都不签名（自己构建、自己安装的应用
没有隔离属性，macOS 不会拦）。

应用自己挑一个空闲端口，不用管端口号。

### 端口与目录

| 变量 | 作用 | 默认 | 谁在用 |
|:--|:--|:--|:--|
| `PORT` | 服务监听端口（只监听 `127.0.0.1`）；被占用时自动换 | `4173` | 服务端 |
| `PI_SESSIONS_DIR` | Pi 会话文件根目录 | `~/.pi/agent/sessions` | 服务端 |
| `PI_REQUEST_STORE_DIR` | 请求正文目录 | `~/Library/Mobile Documents/com~apple~CloudDocs/PiRequests` | 服务端与探针 |

会话目录只有服务端用；请求目录两边都要一致，否则页面对不上号。

## 接入 Pi：装探针

探针是 Pi 扩展，源码在 `ext/index.ts`，只有一个钩子：`before_provider_request`。
它把这次请求的原始请求体写成文件，放进请求目录：

```
<请求目录>/<会话 id>/req-<六位序号>-<紧凑时间戳>.json
```

文件名就是页面上显示的那个唯一标识。

**加载方式**（两种选一种，同时用会重复加载）：

```bash
# 方式 A：个人扩展转发（推荐，重启 Pi 后一直生效）
mkdir -p ~/.pi/agent/extensions
cat > ~/.pi/agent/extensions/pi-observer.ts <<'EOF'
export { default } from "/绝对路径/pi-observer/ext/index.ts";
EOF

# 方式 B：临时加载（适合验收）
pi --extension /绝对路径/pi-observer/ext
```

装完重启 Pi 或执行 `/reload`。

### 请求目录在哪

默认是 iCloud Drive 下的一个文件夹：

```
~/Library/Mobile Documents/com~apple~CloudDocs/PiRequests/
```

用环境变量 `PI_REQUEST_STORE_DIR` 可以改。**看板服务和探针要用同一个目录**：
看板靠它把请求文件和对话里的助手消息对上号。看板侧的同名变量是
`PI_REQUEST_STORE_DIR`，会话目录则是 `PI_SESSIONS_DIR`。

## 页面

单页：左侧是项目分组与会话列表，右侧直接打开该会话的时间线；
地址栏用 `?session=<id>` 同步当前会话。

| 区域 | 行为 |
|:--|:--|
| 会话列表 | 按项目（cwd）分组，显示会话名（首条用户消息）、文件大小与最后修改时间 |
| 会话头 | 工作目录、会话 id、文件路径、条目数、Turn 数、工具数、用量、成本，以及「刷新」按钮 |
| 时间线 | 按用户消息分组（一个 Turn = 一条用户消息 + 它之后的全部条目），默认最近 20 个 Turn，「加载更早」每次再加 20 个 |
| 行详情 | 每行行首的 `more` 按钮打开弹窗：这一条条目的原始 JSON，工具行还带参数与结果 |
| 请求标识 | 助手消息下方显示 `req-<序号>-<时间戳>`，就是请求正文文件名 |
| 顶部筛选 | 按组开关：消息 / 会话 / 模型 / 工具；默认全开，写入 `localStorage` |
| 主题 | 亮色 / 暗色切换 |

## 数据从哪来

| 来源 | 提供什么 | 怎么读 |
|:--|:--|:--|
| 会话 JSONL | 消息、工具调用与结果、token 与成本、分支、模型切换、压缩记录 | 打开页面时读文件；解析结果按「路径 + 修改时间 + 大小」缓存在内存里（最近 3 个会话） |
| 请求目录 | 只有文件名与大小，用来把请求对上助手消息 | 只列目录，不读文件内容 |

### 请求怎么和对话对上

请求与响应是串行的：一条助手消息对应一次请求。所以对号规则是
「时间不晚于这条助手消息、且还没有被用掉的最后一个请求文件」。
中途失败重试会多出一个请求文件，多出来的那个自然对不上任何消息。

对不上的请求文件数会记在会话数据里（`unmatched_requests`），页面上不单独显示。

## 配置

配置就是上面「端口与目录」那三个环境变量，没有别的。

## 目录结构

```
src/app/            页面与 API 路由（Next.js App Router，全部 nodejs 运行时）
src/components/     单页外壳、会话列表、时间线、详情弹窗
src/lib/            会话文件解析、请求目录、行模型、树
ext/index.ts        Pi 探针（只有一个钩子）
tools/acceptance/   离线验收脚本
test/               单元测试
docs/design.md      设计说明：为什么这么做
desktop/            桌面外壳（Electron）与打包脚本，不参与服务本身
```

## 开发与验证

```bash
npm test         # 单元测试
npm run typecheck
npm run build
npm run accept   # 离线验收：临时目录与空闲端口，不碰真实数据
npm run check    # test + typecheck + build
npm run verify   # check + accept
```

## 文档

- `docs/design.md`：设计说明（数据从哪来、为什么只有一个钩子、对号规则、空间占用）
