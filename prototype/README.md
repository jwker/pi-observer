# pi-observer 原型

给后续开发当参考的可点击原型。纯静态 HTML/CSS/JS，没有构建步骤，没有网络请求，也没有任何写操作。

打开方式：

```bash
open prototype/index.html          # 或者直接用浏览器打开这个文件
```

## 文件

| 文件 | 页面 | 对应 PRD |
|:--|:--|:--|
| `index.html` | 会话列表：按项目分组、筛选、概览指标 | §11.1 |
| `session.html` | 会话详情：左侧消息树 + 右侧时间线 / 请求 / 工具三视图，实时正文演示 | §11.2 |
| `request.html` | 请求详情：payload 脱敏展示、响应头、token 与成本、关联说明 | §4.4、§8.6、§13 |
| `tool.html` | 工具调用详情：参数、结果、部分结果、失败态 | §5.2、§7.3 |
| `jsonl.html` | 会话文件原始条目：读取规则、条目类型、原始行 | §4.2、§9.2 |
| `probe.html` | 探针状态：连接、队列、事件订阅清单、只读约束、保留与清理 | §7、§8.6、§14 |
| `style-guide.html` | 设计规范：色板、字号、组件、颜色语义、页面清单 | — |
| `styles.css` | 设计系统（所有 tokens 在这里） | — |
| `app.js` | 交互：标签页、开关芯片、筛选搜索、树折叠、实时正文模拟 | — |

## 点击路径

```
index.html ──点击任意会话行──▶ session.html
session.html ──时间线里的请求链接 / 请求标签页──▶ request.html
session.html ──时间线里的工具 / 工具标签页──▶ tool.html
session.html ──右上角 J JSONL──▶ jsonl.html
任意页面顶栏 ──▶ index.html / probe.html / style-guide.html
```

## 设计语言

借鉴的是"深色终端 + 编辑器排版"这一类观感，布局与内容全部按本项目需要重新设计：

- 全部等宽字体，数字 `tabular-nums` 右对齐
- 只用 1px 发丝边框和背景层次区分区块，不用投影、不用渐变
- 微标签用 10px 大写 + `.12em` 字距承担层级
- 颜色只表达语义：绿=成功/进行中、琥珀=警告/空闲/成本、红=失败/丢弃、蓝=链接/provider、紫=消息层、粉=工具层、青=会话层
- 圆角三档：4px 控件、6px 面板、10px 大容器

改配色、字号、行高：只改 `styles.css` 顶部的 `:root`，所有页面同步生效。

## 原型里的交互约定（`app.js`）

| 属性 | 用法 |
|:--|:--|
| `data-tabgroup` + `data-tab` / `data-panel` | 标签页。`data-tab="x"` 的按钮控制 `data-panel="x"` 的面板 |
| `data-chip="名字"` | 开关芯片，切换时给 `<html>` 加/去 `hide-名字` 类；`data-default="off"` 表示初始关闭 |
| `data-filters` + `data-filter-group` / `data-filter-value` | 分段筛选；被筛的行需要 `data-row` 且带上 `data-<group>` 属性 |
| `input[data-search]` | 在同一个 `data-filters` 作用域内按文本过滤 `data-row` |
| `data-tree-toggle` / `data-box-toggle` | 树节点与 Turn 框的折叠；点击同时切换选中态 |
| `data-stream="文本"` | 实时正文演示，逐段显示并更新快照计数 |
| `data-copy="#选择器"` | 复制目标节点的文本 |

快捷键：`T` 思考、`O` 工具、`H` 隐藏消息、`J` 跳 JSONL、`/` 聚焦搜索。

## 刻意不包含

- 真实数据。所有数字与会话都是写死的示例，方便对照样式。
- 任何写操作。没有删除、隐藏、重命名、重跑、停止、发送。
- 后端与网络。原型只表达界面与信息结构。

## 加页面时

复制一份最接近的页面，改 `data-panel` 的名称与顶栏的 `active` 类；样式一律复用 `styles.css` 里的类，不要写新的行内颜色。
