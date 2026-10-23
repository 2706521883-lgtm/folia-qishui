# 背景类型：壁纸引擎（Wallpaper Engine）

> 把本机 Wallpaper Engine 的场景壁纸当作 Folia 播放器的**背景层**：Folia 只负责「开一个隐藏的 WE 窗口 → 采集它的画面 → 画到背景画布上」，**不改动磁盘上任何壁纸工程的字节**。与 `docs/wallpaper-mode.md` 是相反方向的两件事——那份文档是把 Folia 变成系统壁纸，这份是把系统壁纸搬进 Folia。

平台：`win32` + Electron（`desktopCapturer` 只能在桌面端用）。浏览器形态下选择器里**仍然**会出现「壁纸引擎」——背景注册是构建期行为、不分平台——只是采集层不启动，设置卡显示「仅 Windows 桌面版支持壁纸引擎背景」。

## 一、原理链路

```text
歌词样式 → 壁纸模式页签 / 命令面板
   └─ 背景模式 'we'（src/components/visualizer/backgrounds/we/entry.tsx）
        ├─ 识别：IPC wallpaper-engine-scan → wallpaperEngineLibrary.cjs 扫描 Steam 库
        │        ├─ scene：带合法 PKGV 包的工程 → 交给 WE 采集
        │        ├─ web：project.json 直接交给 WE → 交给 WE 采集（实测可用）
        │        └─ video：project.file 指向本地 mp4/webm → 内置播放（不启动 WE）
        │
        ├─ 内置视频：folia-we://media/<itemId>（Range/206 流式读取本地视频）
        │        └─ <video loop muted> 铺满背景层（透明度/缩放/位移可调）
        │
        └─ 场景/网页：IPC wallpaper-engine-start → wallpaperEngineRuntime.cjs
                 ├─ 定位并验签 wallpaper64.exe（Authenticode = Skutta Software）
                 ├─ 等 `-control getWallpaper -monitor 0` 连续两次应答（引擎可能还没起）
                 ├─ 先清理上次残留的 `Folia Wallpaper` 前缀播放窗口
                 └─ `-control openWallpaper -file <project.json> -playInWindow "<唯一标题>" ...`
                    → 原生（koffi/user32）轮询等该窗口出现，套上 TOOLWINDOW/NOACTIVATE、
                      删掉任务栏按钮、挪到主屏右下角（留 4px 可见）并压到 Z 序底部
                    → 会话期间每 750ms 守护：样式被重置/位置漂移/被激活就立即修复
                    → 按重试表反复 `-control applyProperties RAW~({"volume":0,…})~END`
                 └─ 呈现：desktopCapturer 按窗口标题找到该窗口 → getUserMedia 采集成 MediaStream
                          → <video muted playsInline> 铺满背景层（透明度/缩放/位移/帧率可调）
```

- **视频为什么可以内置**：video 工程的 `project.file` 就是普通 mp4/webm，Chromium 能直接解码，不需要 WE 的场景引擎。协议处理器按 index 里的 item id 反查文件，支持 Range 请求，`<video>` 可以流式播放/循环，不把大文件读进内存。
- **scene 为什么只能采集**：`.pkg` 是 WE 的私有场景包，渲染依赖 WE 自己的 DirectX 场景引擎/着色器/粒子/音频分析；在 Folia 里重写等于重做一个 Wallpaper Engine。web 工程则实测可以用 `openWallpaper` 打开，所以仍走加固后的采集路径，而不是在 Folia 里执行任意 Workshop HTML。
- **为什么是「采集」而不是「嵌窗口」**：DWM 缩略图（`DwmRegisterThumbnail`）需要原生窗口句柄与额外 helper 进程，`SetParent` 又会把 WE 窗口从它自己的渲染循环里撕出来。采集方案复用仓库既有的 `desktopCapturer` 通道（`electron/main.cjs` 里主窗口截图用的是同一条路），零原生依赖、零打包成本。
- **为什么 WE 窗口要「藏」**：`openWallpaper` 的 `-playInWindow` 会开一个真实顶层窗口。只挪到屏幕外不够——它仍然是任务栏/Alt+Tab 里的普通窗口。原生管理器给它加 `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`、清 `WS_EX_APPWINDOW`，再做一次 hide/show 让 shell 删除已经注册的任务栏按钮；窗口仍在渲染，`desktopCapturer` 照常拿帧（实测 1px 可见 + 该样式组合仍能枚举并采集）。
- **为什么不改壁纸文件**：静音走运行时属性（`applyProperties`），工程目录保持只读。用户随时可以在 WE 本体里照常使用同一个壁纸。

## 二、主进程模块

### 1. `electron/wallpaperEngineLibrary.cjs`（库索引 + 预览协议）

- **Steam 定位**：HKCU `Software\Valve\Steam` 的 `SteamPath`，失败回落 HKLM `SOFTWARE\WOW6432Node\Valve\Steam` 的 `InstallPath`，再读 `steamapps/libraryfolders.vdf` 里所有 `"path"` 得到全部库根。`reg query` 输出用纯文本正则解析（`    Name    REG_SZ    value`），不引入注册表依赖。
- **容器**：`steamapps/workshop/content/431960/<id>/`（创意工坊）与 `steamapps/common/wallpaper_engine/projects/myprojects/**`（本地工程）。
- **三种工程**：`project.json` 的 `type` 大小写归一后决定走哪条路：
  - `scene`：目录里必须存在 `.pkg`/`.pak` 且能在包里找到 `/^PKGV\d{4}$/i` 版本魔数（相对路径来自 `project.file`，找不到就扫目录）→ `enginePlayable`，交给 WE 采集。**魔数不在文件第 0 字节**：真实包开头是 4 字节小端长度前缀再跟魔数（实测 `08 00 00 00 "PKGV0005"`），所以探测偏移取 4，兼容偏移 0；这条踩过坑——按偏移 0 判定时 126 个场景全部被判成不可播放。
  - `web`：`enginePlayable`，`project.json` 直接交给 WE（实测 `openWallpaper` 可以打开网页壁纸），仍走采集，不在 Folia 里执行任意 Workshop HTML。
  - `video`：`project.file` 必须落在工程目录内、扩展名属于 mp4/m4v/webm/ogv/ogg → `builtinPlayable`，由渲染端 `<video>` 内置播放，不启动 WE。
  - 扫描结果里**保留**全部条目（含未知类型/无包场景）；选择器列出 `enginePlayable || builtinPlayable`，其余由底部「另有 N 个不支持的壁纸」交代，用户不会以为自己「少了一堆壁纸」。
- **预览图**：按 `preview.gif → preview.jpg → preview.jpeg → preview.png → preview.webp` 顺序取第一张存在的，渲染端通过自定义协议 `folia-we://preview/<itemId>` 取用。
  - **`itemId` 是路径哈希（sha1 前 16 位，分隔符归一 + 小写）**，渲染端永远拿不到真实路径：协议处理器在服务端把 id 解析回扫描索引里的条目，`net.fetch(pathToFileURL(...))` 出图。这样恶意/坏值的 id 只会 404，不会变成任意文件读取。
  - 视频走 `folia-we://media/<itemId>`：同样的 id → index 反查，`fs.createReadStream` 流式返回，支持单段 `Range`（206 + `Content-Range`），`HEAD` 返回长度；不把 700MB 的文件读进内存，也不让渲染端拼路径。
  - 单个工程目录的 `project.json` 有 1MB 上限、整个扫描 4000 个目录上限、单工程最多 256 条属性——避免一个畸形工程把主进程拖死；视频路径必须通过 `path.relative` 留在工程目录内。
- 扫描结果缓存 30s（`ensureFresh`），设置卡打开时自动扫一次，「重新识别」强制刷新。
- 自定义协议必须在 `main.cjs` 里**那唯一一次** `registerSchemesAsPrivileged([...])` 调用中登记（`standard + secure + supportFetchAPI + corsEnabled + stream`）——再调一次会把先注册的协议权限全部洗掉。

### 2. `electron/wallpaperEngineRuntime.cjs`（引擎 + 播放窗口 + 静音）

- **可执行文件**：在各库根下找 `steamapps/common/wallpaper_engine/wallpaper64.exe`（回落 `wallpaper32.exe`），**先验签再用**：PowerShell `Get-AuthenticodeSignature` 的状态必须是 `Valid` 且签发主体匹配 `/\bSkutta Software\b/i`。这是唯一一处「拒绝执行」的安全门。
- **控制通道就绪**：`-control` 子命令在引擎未运行时不一定失败给出可信信号（实测 `getWallpaper -monitor 0` 返回 exit 0 且 stdout 为空），所以判定标准是「**连续两次**探针成功」并缓存 2.5s；`start()` 里 `openWallpaper` 失败会 `force` 重探后重试一次。
- **引擎自举**：不带参数 spawn 一次 `wallpaper64.exe`（`windowsHide`、`stdio:'ignore'`、`unref`）把常驻引擎拉起来，再等 720ms 让进程稳定，然后轮询控制通道（总预算 25s）。
- **播放窗口**：`-control openWallpaper -file <project.json> -playInWindow "<标题>" -width -height -x -y -borderless`。
  - **标题**是会话非碰撞的（`Folia Wallpaper <seed12><随机 6 位>`），因为窗口只靠标题寻址；渲染端拿不到也不该拼这个标题——`getWallpaperEngineCaptureSource()` 由主进程自己读状态里的标题去找 `desktopCapturer` 源。
  - 尺寸夹在 480–3840（`clampPlaybackSize`），坐标取主窗口所在显示器的 DIP 几何 × `scaleFactor`。
- **静音**（`applyProperties`）：
  - 恒定下发 `volume = 0`；再按 `project.json` 的属性表派生场景专属静音值：滑块取最小值（分贝类取 `min`，无 min 时 -60）、布尔开关按「静音」语义取反、下拉框选带 None/Off/静音 字样的选项（没有就退回 value `'0'`）。
  - **只压音频属性**：命中 `visuali[sz]er / bars / color / opacity / 频谱 / 颜色 …` 这类视觉语义、且没有明确音频控制词的属性一律不碰（否则「音频可视化条高度」会被静音成 0）。
  - **命令行编码**：含 `RAW~(...)~END` 的调用走**逐字命令行**（`windowsVerbatimArguments: true`）——载荷原样进入命令行，其余参数用本地 `quoteWindowsArgument` 手工加引号，`cwd` 设为 exe 所在目录。Node 默认的 Windows 转义会把载荷里的引号改写成 `\"`，引擎直接回 **exit 4**（实测：同一载荷默认编码 4、逐字命令行 0）。
  - **重复下发**：场景可能在启动过程中按自己的存档把音量恢复回来，所以静音走 13 次的重试表（`0,120,320,700,1300,2200,2280,2420,2850,3700,5400,8700,12200` ms）。下发串行化（promise 链），`stop()` 清空所有待发定时器。
  - 载荷前先 `sanitizeMuteProperties`：只放行有限数字 / 布尔 / ≤256 字符字符串，键必须匹配 `/^[a-z0-9_.-]{1,128}$/i` 且不在 `__proto__/prototype/constructor` 黑名单里——坏键会让引擎整包拒绝。
- **窗口管理（原生优先）**：`electron/wallpaperEngineWindowNative.cjs` 用 koffi 直接调 `user32.dll`，`createWallpaperEngineWindowManager()` 优先选它，PowerShell helper 只在 koffi/原生加载失败时兜底。
  - **找窗口**：`EnumWindows` + `GetWindowTextW` 逐字比较标题（默认最多 8s、每 80ms 一次），再用 `QueryFullProcessImageNameW` 校验属主确实是 `wallpaper64.exe`/`wallpaper32.exe`（**属主不对就不碰**）。
  - **藏窗口**：`GetWindowLongPtrW(GWL_EXSTYLE)` → 加 `WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE`、清 `WS_EX_APPWINDOW` → hide/show 一次（让 shell 删掉已注册的任务栏按钮）→ `SWP_FRAMECHANGED` 生效。任务栏和 Alt+Tab 里都不再有它，点击也不会激活/抢焦点。
  - **Park**：默认目标是虚拟桌面右下角向内 4px（`GetSystemMetrics(76..79) - 4`），窗口主体落在所有显示器并集之外，不会在相邻副屏上漏出一条实时画面；`SetWindowPos(HWND_BOTTOM, ...)` 同时移动、把窗口压到 Z 序底部，**尺寸沿用引擎实际量到的 width/height**（引擎会夹/忽略请求的几何；实测请求 `3712×2049 @ (3711,1629)`，实际拿到 `2982×1670 @ (3481,1199)`）。
    - 虚拟角可能落在已经关闭/休眠的副屏，DWM 不再合成，`desktopCapturer` 报 `NotReadableError: Could not start video source`。这时渲染端通过 `wallpaper-engine-log` 的 `capture-failed` 事件通知主进程，runtime 调 `setParkMode('primary')`，改停到**主屏右下角向内 4px**；主屏一定在合成，代价是相邻副屏上可能有一条 4px 细边，只在采集失败的机器上启用。
    - 同一窗口的样式修复不再 hide/show：hide/show 只用于新窗口/首次 park；否则会在采集过程中把窗口藏一下，同样触发 `NotReadableError`。新窗口（句柄变化）仍然 hide/show 以移除任务栏按钮。
  - **守护**：会话期间每 750ms 调一次 `monitorWindow()`；样式被重置就重新套用，位置漂移/尺寸被改就重新 park，被前台激活就重新压到底部；目标角每次重新计算，所以改分辨率/显示器布局也会跟着走。实测把窗口手动移到 `(10,10)` 并改成 800×600 后，下一次 tick 就恢复到原尺寸和 `(3711,1524)`。
  - **孤儿清理**：`start()` 在打开新窗口前枚举所有以 `Folia Wallpaper` 为前缀的引擎窗口，逐个 `closeWallpaper`；关不掉就 `ShowWindow(SW_HIDE)`。`stop()` 的 `closeWallpaper` 失败也会走同样的 hide 兜底，避免多个任务栏项越积越多。
  - **不依赖会话的孤儿守护**：第一次进入引擎采集路径后，主进程每 5s 扫一次 `Folia Wallpaper` 前缀窗口；只要不是当前 `locationTitle`、且窗口仍可见，就关闭/隐藏。它不随 `stop()` 或窗口丢失重置而停止，专门兜住「引擎在会话结束后才重建窗口」和「窗口标题变了」这两类迟到残留。已被隐藏的窗口会被跳过（`EnumWindows` 仍能枚举隐藏窗口，重复关闭只会每 5s 拉起一次控制进程）；关闭+隐藏都失败的窗口按 10s→5min 指数退避，不会无限刷。视频壁纸不启动引擎，不会触发这条。
  - **诊断日志**：所有 `[WallpaperEngine]` 主进程日志同时追加到 `%APPDATA%\Folia\wallpaper-engine.log`，运行期超过 2MB 也会轮转为 `.1`；开头记录 Folia/Electron/平台版本。日志包含后端类型（native/powershell）、park 的 target/before/after、守护修复、孤儿清理和渲染端 `capture-failed`；现场复发时直接取这个文件即可。
  - **自举主界面**：只有控制通道静默、Folia 自己启动引擎时才把 `Wallpaper Engine` 主窗口 hide 掉；引擎已经在跑时不动用户自己打开的窗口。
  - **PowerShell 兜底**：`electron/wallpaperEngineWindow.cjs` 的旧 helper 仍保留（`-EncodedCommand`、逐字标题、超时 16s、永不抛错），只负责一次性 park，没有守护/样式管理。
- **状态**：`{phase, engineReady, executable, locationTitle, itemId, title, width, height, parkX, parkY, muted, audioPropertyCount, mutedPropertyCount, startedAt, error, windowManaged, windowWatchActive, windowLost}`，每次变化通过 `wallpaper-engine-changed` 推给渲染端。

### 3. `electron/main.cjs`（接线）

- 6 个 IPC（全部带 `isTrustedMainWindowContents` 门）：5 个 `ipcMain.handle`——`wallpaper-engine-scan`（返回**裁剪过的目录**：id/标题/类型/来源/创意工坊 id/引擎可播放/内置可播放/内置类型/有无预览/音频属性数，**不含任何路径**）、`-start`、`-stop`、`-status`（带 `supported: platform === 'win32'`）、`-get-capture-source`；再加一个 `ipcMain.on('wallpaper-engine-log')`，接收渲染端诊断与 `capture-failed` 事件（后者触发主屏停靠回退）。
- `before-quit` 里 `teardownWallpaperEngineSession()` 紧挨 `windowsWallpaper.detach()`：关掉采集窗口，不留孤儿置顶窗口。

## 三、渲染端

- **背景注册**：`src/components/visualizer/backgrounds/we/entry.tsx`（`mode:'we'`, `order:60`），`registry.tsx` 的 `import.meta.glob` 自动发现；`src/types/visualizerModes.ts` 的 id 列表必须同步（启动时 `assertBuiltinModeList` 会对账，漏改直接抛错）。
- **入口**：播放器面板的快速背景选择器故意不列「壁纸引擎」（`AppearanceSection` 的 `hiddenValues`），「歌词样式」里的普通背景类型行也不再列它。壁纸引擎是独立页签「壁纸模式」，紧跟在通用/背景/歌词动画/字幕之后；进入该页签即切到 `we`，壁纸库、会话控制和采集参数都在这一页，壁纸库紧跟在当前壁纸预览之后。播放器面板右上角的调色盘按钮打开的就是这个设置窗口。
- **入口回归锁定**：`test/unit/visualizer/backgroundRegistry.test.ts`（内置背景 id 列表含 `we`）与 `test/ui/wallpaperEngineBackground.spec.ts`（「歌词样式」页签行有独立的「壁纸模式」，普通背景类型行不含「壁纸引擎」）。若在已安装的 App 里看不到这个页签，先确认那份 App 是不是由本源码构建的：安装目录 `resources/app` 里搜不到 `wallpaperEngine` 就是旧构建，本功能不在其中。
- **内置视频**（`we/WeBuiltinVideoLayer.tsx`）：`tuning.itemKind === 'video'` 时完全不走 WE 会话，直接 `<video src="folia-we://media/<itemId>" loop muted={muteAudio} playsInline>`；透明度/缩放/位移与采集层共用同一套 CSS。首帧前显示 `folia-we://preview/<itemId>` 海报；解码失败（例如 HEVC 编码）也回退到海报，不会黑屏。窗口隐藏/最小化时暂停播放。
- **采集**（`src/services/wallpaperEngineCapture.ts`）：`getUserMedia({video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId, minFrameRate:10, maxFrameRate}}})`。**没有** `setDisplayMediaRequestHandler`——`desktopCapturer` + mandatory 约束这条老路径在 Windows 上不需要用户授权弹窗。
- **图层**（`we/WeBackgroundLayer.tsx`）：`<video muted playsInline autoPlay>` + `object-cover`，透明度/缩放/位移走 CSS `transform`/`opacity`。**采集流只在会话/帧率变化时重建**，所以拖滑杆不会重启采集、不会闪黑；采集失败（例如窗口被 WE 本体抢走）自动退回 `folia-we://preview/<itemId>` 静态预览图，且失败会重试（3 次）而不是一次就永久停在预览图上。
- **切歌词样式不模糊**：背景层挂在 visualizer 子树里，换样式时它会不会跟着重建取决于走哪条渲染路径——模式分块懒加载、首访时整棵子树经 `Suspense`（`fallback={null}`）重建；播放页的舞台外壳是稳定的，2026-10-17 实测连切 4 个样式只换掉模式自己的内容 div（`player-visual-surface` 内 2 处 DOM 变更）、背景层原地保留。所以采集流不赌路径：`src/services/wallpaperEngineCapture.ts` 把活着的流放在模块级 `liveCapture` 里留 2.5s **宽限期**：重挂载直接认养同一条流（不重开 `getUserMedia`，`video.srcObject` 立刻接回原流），`WeBackgroundLayer` 的 `streamReady` 初值也取自缓存，因此连一帧低清预览图都不会出现。宽限期到点且没有消费者时才真正 `track.stop()`；换成别的背景类型、停会话仍然是立刻（宽限期后）关掉采集。回归锁：`test/component/weBackgroundRemount.spec.ts` + 探针 `dev/probes/weBackgroundRemount.probe.tsx`（`canvas.captureStream` 造假采集，数预览图出现次数与 `getUserMedia` 调用次数）。
- **会话驱动**（`we/WeBackground.tsx` + `src/stores/useWallpaperEngineStore.ts`）：`subscribeWallpaperEngineStatus()` 订阅主进程推送 + 启动时拉一次全集；自动启动受 `enabled && supported && tuning.autoStart && itemId && phase === 'idle'` 约束；背景模式切走时停会话（`stopSession`），不留后台窗口。**`itemKind === 'video'` 时不启动引擎会话**，由 `<video>` 自己播放；切到视频时会停掉仍在运行的场景会话。**卸载也算切走**：组件被卸载时停会话的 effect 根本跑不到（切背景类型、离开播放页都会卸载），所以由模块级的 `IDLE_STOP_DELAY_MS = 3000` 兜底——最后一个背景层卸载 3 秒后仍没有重新挂载就 `stopSession()`；3 秒内重新挂载（切歌词样式必然如此）则取消这次停，引擎与采集都不重启。
- **设置卡**（`we/WeBackgroundSettingsCard.tsx`）：识别/重新识别、启动/停止（视频时隐藏，因为视频自动播放）、恢复原背景（停会话并清空选择）、自动启动 + 静音壁纸音频两个开关（视频时隐藏自动启动）、5 个滑杆（透明度 0.15–1、缩放 1–1.6、水平/垂直位移 ±50、采集帧率 15–60 步长 5；视频时隐藏采集帧率），以及状态行（未支持 / 出错 / 已静音 / 播放中 / 内置视频播放中 / 就绪 / 没找到 Steam / 空闲）。壁纸网格给每一项标「内置」或「引擎」。
- **调参持久化**：`we_background_tuning`（`src/stores/visualizerSettingsPersistence.ts` 里夹取后再写），其中 `itemKind` 记录 scene/video/web，空值按旧版 scene 处理。**导出的视觉配置里 `itemId` 故意不外传**（它哈希了本机安装路径），只带标题+外观参数——换机器导入后会提示重新挑一张。

## 四、踩坑记录

1. **`registerSchemesAsPrivileged` 只能调一次**——二次调用会把先前注册协议的特权剥掉，`folia-we://` 必须加进原有的那一个数组。
2. **控制通道「就绪」不能用单次探针判定**：引擎冷启动期间探针可能「成功但没内容」。判定标准是连续两次成功。
3. **静音是持久战**：一次性 `applyProperties` 会被场景自身的存档覆盖，必须按重试表反复下发。
4. **别把「提到声音的视觉属性」静音**：`AUDIO_VISUAL_HINT` 优先于音频关键词，纯视觉属性即使在名字里带 audio/music 也不动。
5. **窗口几何用物理像素、坐标用 DIP**：混合缩放多屏下用 Electron 的 display bounds 直接算物理角会落进某块真实显示器里；所以权威值由 PowerShell 的 `GetSystemMetrics` 给出。
6. **helper 不认 `$pid`**：`$pid` 是 PowerShell 只读自动变量，赋值直接抛错——用 `$ownerProcessId`。
7. **`arguments[2]` 在箭头函数里没有意义**：箭头函数没有自己的 `arguments`，会落到 CommonJS 包装对象上。第一版 `indexProject` 就踩了这个坑。
8. **`__proto__` 在对象字面量里是设原型而不是设键**：想测黑名单必须用 `JSON.parse` 造出真正的自有键。
9. **别在 registry 的 `render` 箭头里调 hook**：它们是父组件渲染期当普通函数调用的，hook 会挂到父 fiber 上、切模式时 hook 顺序直接炸。所以拆出 `WeBackground` / `WeQuickControls` 两个组件（与 `SoraBackground.tsx` 同一模式）。
10. **`AppearanceSettingsSubview.tsx` 有自己的 `useShallow` 选择器表**，新增设置项要同时加到 store 的紧凑表和这个本地表，否则运行时 undefined。
11. **同一台 Steam 会被注册表报出两种拼写**（HKCU `e:/steam` vs HKLM `E:\steam`），库根去重必须按「分隔符归一 + 小写」的键比较，只比 `toLowerCase()` 会让每个容器被扫两遍（实测扫描耗时翻倍）。
12. **`.pkg` 的 PKGV 魔数在偏移 4**，见上文；判定函数要把命中偏移一起返回，否则 `scenePackageHeader` 会报出 `\b\0\0\0PKGV` 这种脏值。
13. **`applyProperties` 的 RAW 载荷必须走逐字命令行**：默认 `execFile` 编码把载荷里的 `"` 转义成 `\"`，引擎读不了就回 exit 4（首次实测每次都 4，逐字命令行稳定 0）。另外逐字模式下**不能把命令名写成 `wallpaper64.exe` 裸名**——Node 不会去 `cwd` 里找可执行文件，直接 `ENOENT`，必须给完整路径。
14. **`openWallpaper` 返回 ≠ 窗口已存在**：引擎是异步开窗的，冷启动时（第一次加载某个 4.5MB 的 GIF 场景）第一眼经常找不到窗口，一次性 `FindWindow` 会输掉这个竞态、park 报 `not-found`，窗口就一直盖在屏幕中间。参照实现也是「轮询等窗口出现」。
15. **`SetWindowPos` 传 0,0 当尺寸 = 把窗口缩成 0×0**：`SWP_FLAGS` 里没有 `SWP_NOSIZE`，于是「只移动」变成了「移动并清零尺寸」，采集只会拿到空帧。要么把量到的 width/height 传回去（当前做法），要么加 `SWP_NOSIZE`。
16. **`FindWindow` 是大小写不敏感的**，标题寻址要求逐字相等才能避免撞上「只差大小写」的同名窗口；所以帮助脚本改成 `EnumWindows` + `string.Equals(..., Ordinal)`，顺带也不再受 A/W 两套 API 的影响。
17. **`enabled=false` 拦不住卸载**：停会话原本写在「`enabled` 变 false」的 effect 里，但切背景类型、离开播放页是把 `WeBackground` 整个卸载，effect 没机会跑，parked 的引擎窗口就一直在后台播（静音、不出画面，但一直烧 GPU）。所以补了卸载路径：最后一个背景层卸载后 3 秒没重新挂载才 `stopSession()`——延迟是必需的，切歌词样式的卸载-重挂载间隔只有几十毫秒，立刻停会让每换一次样式都重启一次引擎（连带采集重开）。回归锁：`test/component/weSessionUnmountStop.spec.ts` + `dev/probes/weSessionUnmountStop.probe.tsx`（桩住 store 数调用），以及真机实测 `dev/we-live-session-stop-check.cjs`。
18. **背景层可能被「卸载重建」，于是「模糊一下」会变成「一直模糊」**：切歌词样式会换掉整棵模式子树（模式各自懒加载分块，首访经 `Suspense` 重建；播放页舞台外壳虽稳定，实测也确实存在让背景层 DOM 整体重建的路径），背景层就在这棵子树里。旧实现卸载即 `track.stop()`、重挂载只能重新 `getUserMedia`；2026-10-17 实测那次重开在 2.5s 后仍未接上（新 `<video>` 的 `srcObject` 还是空），于是整段会话都停在 `folia-we://preview/` 那张低清预览图上——用户看到的就是「切样式时壁纸模糊一下」。修法：采集流缓存 + 宽限期认养（重挂载复用同一条流），加上取流失败重试，`streamReady` 初值取自缓存以免首帧回退。
19. **park 一次不够**：实测 `openWallpaper` 返回、helper 挪到 `(3711,1524)` 之后，引擎仍会在场景加载过程中把窗口再挪到 `(3999,2036)`；窗口重建/改分辨率/改 GPU 偏好也会让位置和扩展样式回到默认。所以必须有会话期 `monitorWindow()`（750ms）持续修正，不能只依赖 `start()` 后的一次 helper。
20. **只挪到屏幕外不解决任务栏**：WE 的播放窗口扩展样式实测是 `0x00000000`，是普通顶层窗口，任务栏和 Alt+Tab 都会列出来。`WS_EX_TOOLWINDOW` 单独加上去不一定会让 shell 撤掉已经注册的按钮，必须配合一次 hide/show；实测在 1px 可见 + `TOOLWINDOW|NOACTIVATE` 的组合下，`desktopCapturer` 仍能枚举并采到实时帧（800×450，连续 5 帧），所以「藏起来」和「采集」不冲突。
21. **视频走 `<video>` 必须支持 Range**：Chromium 的媒体栈会用 `Range: bytes=...` 探测/循环；协议处理器返回 200 整文件也能播，但会退化成一次性下载，700MB 的工程会明显卡。`serveVideo` 用 `fs.createReadStream` 返回 206 + `Content-Range`，范围外的请求回 416，HEAD 只回头。实测 31MB mp4：Range 206、`readyState=4`、`videoWidth=1920`、`currentTime=2.96`。
22. **koffi 的 proto 类型名是进程级的**：`koffi.proto('EnumWindowsProc', ...)` 如果和探针脚本/其他模块重名会直接抛 `Unknown or invalid type name`，而且失败会被 manager 静默降级到 PowerShell（表面现象是「原生管理器没启用」）。原生模块用 `FOLIA_WE_ENUM_PROC`、`FOLIA_WE_RECT` 这类带前缀的名字；诊断时看 `[WallpaperEngine] window manager backend:` 这行。

## 五、现场验证脚本（`dev/`）

这些脚本都直接驱动本机真实引擎，运行前先 `unset ELECTRON_RUN_AS_NODE`（否则 `npx electron` 会退化成纯 Node）。`we-dev-ui-check.cjs` 例外：它不碰引擎，连的是一个带 `--remote-debugging-port=9222` 启动的 dev 应用（`ELECTRON_DEV=true`），只驱动界面：

| 脚本 | 作用 | 是否改动画面 |
| --- | --- | --- |
| `dev/we-scan-probe.cjs` | 只读扫描库：库根、按类型计数、可播放/预览/音频属性数、`getItem` 反查 | 否 |
| `dev/we-pkg-probe.cjs` | 只读打印真实 Scene 工程的包文件与头部字节 | 否 |
| `dev/we-control-probe.cjs` | 只读：exe 候选、Authenticode 状态、`getWallpaper` 探针原始输出 | 否 |
| `dev/we-mute-probe.cjs` | 开一个窗口后对比 `applyProperties` 的几种调用方式（默认编码 / 逐字 / cmd.exe）的退出码 | 是（开一个 parked 窗口，结束即关） |
| `dev/we-e2e.cjs` | 全链路验收：扫描 → 开窗 → park → 采集出真帧 → 静音被确认 → 关窗消失；任一环失败即非零退出 | 是（同上） |
| `dev/we-diag.cjs` | 窗口身份诊断：列出含标题的窗口（class/pid/rect）+ FindWindow 探针 | 是（同上） |
| `dev/we-dev-ui-check.cjs` | 桌面开发态入口自检：连 CDP 打开「歌词样式 → 壁纸模式」，断言独立页签存在、设置卡渲染、无浏览器平台提示，并截图到 `%TEMP%` | 否 |
| `dev/we-pick-wallpaper.cjs` | 装机版免手挑：走真 UI（背景类型行 → 更多设置 → 识别壁纸 → 点条目）选一张壁纸，让会话有东西可放；`node dev/we-pick-wallpaper.cjs 9222 "标题子串"` | 是（切换当前壁纸与会话） |
| `dev/we-live-session-stop-check.cjs` | 会话生命周期实测：点面板真控件，断言「切走背景类型 → 宽限期后才停」「切回来自动重启并接上采集」「切歌词样式不停会话」，结束时还原背景类型与歌词样式；失败即非零退出。开发态与**装机版**通用（见下） | 是（切走背景类型再切回，会短暂换掉画面） |

**在跑着的 dev 应用里验行为只点真 UI**：CDP 里 `import('/src/stores/...')` 走的模块 URL 不带 HMR 的 `?t=` 版本号，改到的可能是**另一个 store 实例**——写进去的值会落盘（localStorage 看得见变化），界面却一点不动，很容易误判成「组件不重渲染」。所以这两个行为都是用真实控件验的：面板「外观」两行的 `歌词样式 ± / 背景类型 ±` 箭头（`aria-label` 分别是 `歌词样式 +/−`、`背景类型 +/−`），只读信号取主进程的 `window.electron.getWallpaperEngineStatus()` 与 `[data-testid="player-visual-surface"]` 上的 MutationObserver，都绕开前端 store。2026-10-17 实测：`背景类型` 从「壁纸引擎」切到「通用」→ 1s 后背景层卸载、3s 时 `phase` 转 `stopping`、4s 转 `idle` 且 `itemId` 清空；切回「壁纸引擎」→ 会话自动重启、采集重新接上（先出现一张预览图，接上后让位）；`歌词样式` 连切 4 个（莫奈→时计→群唱→镜台）→ 合计约 10s 的轮询里 `phase` 全程 `running`，`posters` 恒为 0。

**在装机版里跑同样的检查**（2026-10-17，`<安装目录>\Folia.exe --remote-debugging-port=9222`，页面是 `file:///<安装目录>/resources/app/dist/index.html`）：这条路有三个和 dev 不同的地方——

1. 装机版**没有 `/src` 可 import，也不是 dev 服务器**。面板不在屏幕上时脚本得走**命令面板**自己叫出来：`Ctrl+K` → 输入 `Panel: controls` → 回车（`ensureAppearancePanel` 每次尝试前先按一次 `Esc`，上一轮留下的弹窗会吃掉快捷键，第一版就因此偶发在「找不到 背景类型 行」上失败）。
2. **首次跑之前得先有一张选中的壁纸**：装机版的 localStorage 里没有 `itemId` 时会话根本不会起（现象是 `getWallpaperEngineStatus()` 一直 `phase: idle`），用 `dev/we-pick-wallpaper.cjs` 挑一张即可。
3. **不是所有歌词样式都挂共享背景层**（浮名在今天的构建里挂得上，但环里存在挂不上的样式）。切到那种样式时背景层会真的卸载、宽限期到点会话正常停——**这是功能本身，不是回归**。所以第 3 步加了判定：只有在「背景层还在（video/poster 非零）」的前提下把会话停了才算失败，否则打印「该样式不挂背景层，第 3 步跳过」并照常还原。

实测输出：

```
rows: 歌词样式 = 浮名, 背景类型 = 壁纸引擎
start: phase=running itemId=cbab6cb498dfb21a {"videos":1,"stream":true,"posters":0}
capture attached: true
after leaving 壁纸引擎: layerGoneAfter=1ms phase=idle after=3134ms
back on 壁纸引擎: phase=running after=824ms captureAttached=true
after 歌词样式 switch: phases=["running",...×10] posters=0 stream=true videos=1->1
restored: 歌词样式 = 浮名, 背景类型 = 壁纸引擎, {"phase":"running","itemId":"cbab6cb498dfb21a"}
LIVE CHECK PASSED
```

## 六、许可与参考来源

- 本仓库以 **AGPL-3.0** 分发（见 `LICENSE`）。本功能新增文件沿用 AGPL-3.0。
- 引擎控制协议、Authenticode 验签门、「就绪后再发指令」规则、无参自举引擎、含 `RAW~` 载荷的逐字命令行调用（`quoteWindowsArgument`）、静音重试表与场景音频属性启发式、以及「等窗口出现再 park」的 park 配方，均移植自 **Mineradio**（GPL-3.0-only）`desktop/wallpaper-engine-runtime.js` + 库扫描部分，固定修订 `d43de565acabfdc1a9c9820a27e81a98ccbebcef`；模块级归属写在各文件头（`electron/wallpaperEngineLibrary.cjs`、`electron/wallpaperEngineRuntime.cjs`、`electron/wallpaperEngineWindow.cjs`）。
- 与 Wallpaper Engine 作者（Skutta Software）无任何关联；本功能只在本机驱动用户已安装、已购买的正版引擎，不修改、不重分发任何壁纸工程。
