# 桌面外壳

pi-observer 的桌面版：应用启动时在后台拉起看板服务，开一个窗口加载它的页面。

## 现在做到哪一步

已经跑通的是**最小壳**：能拉起服务、能开窗口、页面和数据都正常；
`.dmg` 能打出来并且从 dmg 里直接启动。

探针的安装与卸载原本做在设置页里（`/api/probe`），随项目重写一起删掉了：
探针现在只有一个钩子，手动装一次转发文件就行，详见仓库根目录的 README。

还没做：菜单栏常驻、开机自启、应用图标、代码签名与公证。

## 目录结构

```
desktop/
├── main.js          主进程：挑端口、起服务、开窗口、退出时收服务
├── package.json     Electron 依赖（独立于仓库根目录的 Next 应用）
├── electron-builder.yml  打包配置
└── resources/       构建产物（不入 git）
    ├── server/      看板服务（Next 的 standalone 产出，裁剪过）
    ├── probe/       探针源码（Pi 加载这里的代码）
    └── manifest.json
```

## 怎么跑

开发时（不构建，改代码即时生效）：

```bash
npm run desktop:dev
```

跑构建好的服务（不打包）：

```bash
npm run desktop:run
```

这两条都在仓库根目录跑，不用进 `desktop/`。Electron 依赖没装时自动装一次
（默认走 npmmirror 镜像；想用官方源就设 `ELECTRON_MIRROR`）。

## 打成 .dmg

在仓库根目录跑（等价于 `cd desktop && npm run dmg`）：

```bash
npm run desktop:dmg
```

只想拿到 `.app` 目录（不装，直接双击）就跑 `npm run desktop:pack`。

两个镜像变量已经在根目录的脚本里设好了；如果在 `desktop/` 里直接跑，
要自己设：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dmg
```

产物在 `desktop/out/pi-observer-0.1.0-arm64.dmg`（约 118 MB，装上后 286 MB）。

几点说明：

- **默认不签名**（脚本里设了 `CSC_IDENTITY_AUTO_DISCOVERY=false`）。
  自己构建、自己安装的应用没有隔离属性，macOS 不会拦，双击就开。
- **别让 electron-builder 自动找证书**。钥匙串里通常有一张 "Apple Development"
  开发证书（Xcode 装的时候发的），自动发现它之后 electron-builder 会拿它去签名，
  然后卡在「要 provisioning profile / 钥匙串授权」那一步——表现就是构建不动了。
  开发证书本来也不能用来分发，所以直接跳过签名。
- **要真正分发**（给别人装、免掉 Gatekeeper 提示）需要付费的 Apple Developer Program：
  拿 "Developer ID Application" 证书签名，再做公证。届时把脚本里的
  `CSC_IDENTITY_AUTO_DISCOVERY=false` 去掉，并用 `CSC_LINK` 指向证书文件。
- **图标是自己画的**（`build/icon.svg` → `build/icon.icns`）：
  深色底板上一条蓝色的活动流，末尾一颗绿点表示「正在跑」。
  改了 SVG 之后重新生成 `.icns` 的步骤见下。
- **只构了 arm64**（Apple 芯片）。要 Intel 版把 `electron-builder.yml` 里的
  `arch` 加上 `x64`。
- 打包配置放在 `electron-builder.yml`，不放 `package.json`：后者会被各种工具重写，
  配置单独放不容易丢。
- 服务产物与探针代码走 `extraResources`（落在 `Contents/Resources/pi-observer/`），
  不进 `app.asar`：子进程要能直接读这些文件，asar 里的读不了。

## 改图标

`build/icon.svg` 是源文件。macOS 自带工具不认 SVG，用无头 Chrome 渲染成 PNG，
再用 `iconutil` 拼成 `.icns`：

```bash
node tools/desktop/render-icon.mjs
```

脚本做三件事：用无头 Chrome 把 SVG 渲染成 1024×1024 的 PNG、用 `sips` 缩出各尺寸与
@2x 版本、用 `iconutil` 拼成 `icon.icns`。

`build/icon.icns` 会被 electron-builder 自动用上（`build` 目录是默认的资源目录）。

## 几个关键决定

**服务直接跑在 Electron 的主进程里，不再另起进程。**
这是为了 Dock 里只出现一个图标：另起的进程（用 Electron 的二进制当 Node 起，
或者用工具进程起）都会被 macOS 当成另一个应用注册，Next 又会把进程名改成
`next-server (v16.4.2)`，Dock 里就多出一个没有名字的图标。
只有一个进程就没有这个问题，而且不用往应用包里塞 100 MB 的 Node。

代价：服务崩了应用也跟着崩（会弹窗提示错误），退出时不用另外收进程。
另外 Next 会改进程名，主进程每秒把它改回 `pi-observer`。

**端口随机挑。**
`next start` 的 `-p` 会覆盖 `PORT` 环境变量，而 standalone 产物是直接跑 `server.js`，
`PORT` 生效。随机端口还能避免和用户自己开着的开发服务撞车；
探针与这个壳不再有耦合：它只往 iCloud 的请求目录写文件，不需要知道服务在哪。

**服务只监听回环。**
`HOSTNAME=127.0.0.1`，与命令行启动服务时的边界一致；实测用局域网地址连不上。

**启动检查打的是 `/api/sessions`。**
项目没有 `/api/health` 这个路由了；用会话列表接口做检查更实在——
它会真的去读会话目录，服务能回 200 就说明文件系统与路由都通。

**运行数据目录不再被使用。**
新服务没有数据库，也不往 `~/.pi-observer` 写任何东西：它只读会话文件，
只读 iCloud 里的请求目录名。`PI_OBSERVER_DATA_DIR` 这个变量留着是为了兼容旧版本，
新版本的服务不读它。

## 打包时的注意事项

- `next build` 与 `next dev` 共用 `.next` 目录，不能同时跑；
  打包前先停掉开发服务。
- 资源目录里的 `node_modules/@img`（Next 的图片优化二进制，18 MB）已经在
  `prepare.mjs` 里删掉——这个看板没有用 `next/image`。
- 探针代码放在 `Resources/probe/`，只是作为源码副本；现在没有「安装探针」的功能，
  Pi 侧的转发文件由人自己写（路径写在仓库根目录的 README 里）。
- 改完服务端代码要重跑 `node tools/desktop/prepare.mjs` 刷新资源目录，
  否则壳里跑的还是上一版服务；`npm run desktop` 会自动做这件事。
