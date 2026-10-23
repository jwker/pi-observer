# 桌面外壳

pi-observer 的桌面版：应用启动时在后台拉起看板服务，开一个窗口加载它的页面。

## 现在做到哪一步

已经跑通的是**最小壳**：能拉起服务、能开窗口、页面和数据都正常；
探针的安装与卸载做在设置页里（`/api/probe`）；`.dmg` 能打出来并且从 dmg 里直接启动。

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

先装依赖（Electron 45 的 npm 包没有 postinstall，二进制要另外下；
`postinstall` 已经调了 `tools/desktop/install-electron.mjs`，默认走 npmmirror 镜像）：

```bash
cd desktop
npm install
```

想用官方源就设 `ELECTRON_MIRROR`：

```bash
ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/ npm install
```

再生成资源目录（在仓库根目录执行，会先跑 `next build`）：

```bash
node tools/desktop/prepare.mjs
```

然后起应用：

```bash
cd desktop
npm start
```

## 打成 .dmg

```bash
cd desktop
npm run dmg
```

产物在 `desktop/out/pi-observer-0.1.0-arm64.dmg`（约 118 MB，装上后 286 MB）。

打包用国内镜像（两个都要）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --mac dmg
```

几点说明：

- **没有签名也没有公证**。自己机器上双击能开；给别人装的话 Gatekeeper 会拦，
  要签名与公证（需要 Apple 开发者账号）。
- **图标还没做**，现在用的是 Electron 默认图标。
- **只构了 arm64**（Apple 芯片）。要 Intel 版把 `electron-builder.yml` 里的
  `arch` 加上 `x64`。
- 打包配置放在 `electron-builder.yml`，不放 `package.json`：后者会被各种工具重写，
  配置单独放不容易丢。
- 服务产物与探针代码走 `extraResources`（落在 `Contents/Resources/pi-observer/`），
  不进 `app.asar`：子进程要能直接读这些文件，asar 里的读不了。

## 几个关键决定

**用 Electron 自带的 Node 跑服务，不用另带一份 Node。**
Electron 的二进制设了 `ELECTRON_RUN_AS_NODE=1` 就是一个纯 Node 运行时
（实测 Electron 45 内置 Node 24.22，`node:sqlite` 可用），直接跑 `server/server.js` 即可。
应用包里因此不用塞 100 MB 的 Node。

**端口随机挑。**
`next start` 的 `-p` 会覆盖 `PORT` 环境变量，而 standalone 产物是直接跑 `server.js`，
`PORT` 生效。随机端口还能避免和用户自己开着的开发服务撞车；
探针靠 `~/.pi-observer/probe.json` 找到服务，不受端口变化影响。

**服务只监听回环。**
`HOSTNAME=127.0.0.1`，与命令行启动服务时的边界一致；实测用局域网地址连不上。

**运行数据仍在工程外。**
默认 `~/.pi-observer`，可用 `PI_OBSERVER_DATA_DIR` 覆盖。

## 打包时的注意事项

- `next build` 与 `next dev` 共用 `.next` 目录，不能同时跑；
  打包前先停掉开发服务。
- 资源目录里的 `node_modules/@img`（Next 的图片优化二进制，18 MB）已经在
  `prepare.mjs` 里删掉——这个看板没有用 `next/image`。
- 探针代码放在 `Resources/probe/`，但 Pi 加载的应该是 `~/.pi-observer/probe/` 下的副本：
  应用被移动或升级后路径会变，指向应用包内部的路径会失效。安装步骤要把探针复制过去。
