<!-- markdownlint-disable MD024 -->
# 0.3.4 优化任务清单

- 分支：`optimize/0.3.4`
- 基线：`d8400d5`（v0.3.3，与远端 `main` 同一提交）
- 范围：推荐流稳定性、错误反馈、跨批次去重、QQ 路由自检、视觉器生命周期
- 不做：上游 0.7.21 的 Spotify/YouTube、探索页、WebGPU 智能动感、MNN 模型栈、Folium 1.6、Linux ARM64

## 实施状态（2026-10-18）

| 编号 | 任务 | 代码 | 单测 | 实机 |
| --- | --- | --- | --- | --- |
| P0-1 | 推荐请求超时与锁释放 | 已完成 | 通过 | 正常路径通过；卡死模拟受 contextBridge 只读限制，由单测覆盖 |
| P0-2 | 失败/空结果提示 | 已完成 | 通过 | 成功提示与无错误日志通过；超时/空结果由单测覆盖 |
| P0-3 | 推荐按钮忙碌状态 | 已完成 | 通过 | 通过（aria-busy、标题、is-busy） |
| P0-4 | 跨批次去重 | 已完成 | 通过 | 通过（历史 12 → 24 → 36，三批无重复） |
| P0-5 | QQ 推荐路由启动自检 | 已完成 | 通过 | 通过（主进程状态 `personalFmRoute: registered`） |
| P0-6 | 窗口隐藏时暂停视觉器/壁纸采集 | 已完成 | 组件测试通过 | 待手动最小化验证 |

验证基线：

- `npm run typecheck` 通过
- 全量单测 **6527 通过 / 2 跳过**
- `weBackgroundRemount.spec.ts` **3 项通过**（含暂停/恢复）
- 实机连续点击推荐流：按钮进入 busy → 恢复；播放不中断（同一首歌时间 23.29s → 29.79s）；提示「已添加到播放队列」；停留在书库
- 实机安装包：`app.asar.bak-20261018-1740`、`Folia.exe.bak-20261018-1740`

## 总览

| 编号 | 任务 | 优先级 | 依赖 | 预估 |
| --- | --- | --- | --- | --- |
| P0-1 | 推荐请求超时与锁释放 | P0 | 无 | 小 |
| P0-2 | 失败/空结果提示 | P0 | P0-1 的错误类型 | 小 |
| P0-3 | 推荐按钮忙碌状态 | P0 | 无 | 小 |
| P0-4 | 跨批次去重 | P0 | 无 | 中 |
| P0-5 | QQ 推荐路由启动自检 | P0 | 无 | 中 |
| P0-6 | 窗口隐藏时暂停视觉器/壁纸采集 | P0 | 无 | 中 |

通用完成标准：

- [ ] `npm run typecheck` 通过
- [ ] `npm run test:unit` 全绿
- [ ] 相关组件测试通过（至少覆盖推荐流按钮与视觉器暂停）
- [ ] 手动验证五个平台：推荐流首次播放、连点追加、断网、超时、空结果
- [ ] 版本号升到 `0.3.4`，安装包与 `latest.yml` 正常

---

## P0-1 推荐请求超时与锁释放

### 目标

任何平台的 `getPersonalFm()` 卡住时，推荐流按钮和队列续批都能在有限时间内恢复，不会永久停在「忙」。

### 现状

- [libraryHomeActions.ts](../src/library/core/services/libraryHomeActions.ts) 用 `personalFmInFlight` 串行化开始/追加，请求不返回就永远不释放。
- [usePlaybackQueueController.ts](../src/hooks/usePlaybackQueueController.ts) 用 `fmRefillInFlightRef` 防止并发续批，同样只在 `finally` 释放。
- [omni.ts](../src/services/onlineMusic/omni.ts) 的 `getPersonalFm()` 和各 provider transport 没有统一超时。
- 已有 `withTimeout`，但只在 [federatedSearch.ts](../src/services/onlineMusic/federatedSearch.ts#L57) 内部使用。

### 改动

- [ ] 新建 `src/utils/withTimeout.ts`，导出 `withTimeout<T>(promise, timeoutMs, label?)` 和 `TimeoutError`；`federatedSearch.ts` 改为复用它（保留原有错误名或做兼容）。
- [ ] 新建推荐流常量（例如 `src/services/onlineMusic/recommendationConstants.ts`）：`PERSONAL_FM_TIMEOUT_MS = 12_000`。
- [ ] `libraryHomeActions.playPersonalFm()` 用 `withTimeout(port.getPersonalFm(), PERSONAL_FM_TIMEOUT_MS)`。
- [ ] `libraryHomeActions.loadMorePersonalFm()` 同样包裹。
- [ ] `usePlaybackQueueController` 的续批 `omni.getPersonalFm()` 同样包裹；确认 `finally` 仍会释放 `fmRefillInFlightRef`。
- [ ] 扩展 `LibraryHomeActionResult`（[homeModel.ts](../src/library/core/contracts/homeModel.ts)）的失败原因：`timeout`，必要时加 `cancelled`。
- [ ] 超时后不要留下未处理的 Promise rejection；`TimeoutError` 与 `AbortError` 分开处理。

### 验收

- [ ] 模拟 provider 永不 resolve：点击推荐流后 12 秒内返回失败，按钮恢复可点。
- [ ] 超时后再次点击可以重新发起请求，不会因为旧锁一直 busy。
- [ ] 队列续批超时后，下一首仍能再次尝试续批。
- [ ] 正常请求的行为、提示和之前一致。

### 测试

- [ ] `test/unit/library/core/libraryHomeActions.test.ts`：用假定时器模拟 pending，推进 12 秒，断言 `{ ok:false, reason:'timeout' }`，随后可再次调用。
- [ ] `test/unit/library/core/libraryHomeActions.test.ts`：开始与追加共用锁时，超时后锁能释放。
- [ ] 若抽出可测试的续批 helper，补一条队列续批超时测试；否则至少在手动清单里覆盖。

### 涉及文件

- [libraryHomeActions.ts](../src/library/core/services/libraryHomeActions.ts)
- [homeModel.ts](../src/library/core/contracts/homeModel.ts)
- [usePlaybackQueueController.ts](../src/hooks/usePlaybackQueueController.ts)
- [federatedSearch.ts](../src/services/onlineMusic/federatedSearch.ts)
- 新增 `src/utils/withTimeout.ts`

### 风险

- 12 秒对极慢网络可能偏短；先做成常量，必要时按平台调整。
- `federatedSearch` 现有错误类型被 UI/测试依赖，抽取时保留兼容。

---

## P0-2 失败/空结果提示

### 目标

推荐流失败、超时、登录过期、没有更多歌曲时，用户能看到明确原因，而不是「点了没反应」。

### 现状

- `playPersonalFm` / `loadMorePersonalFm` 的 `catch` 只 `console.error`，返回 `failed`，UI 不消费结果。
- 空批次直接返回 `{ ok:true }`，没有任何提示。
- 成功追加由 `onAddAllToQueue` 给出提示，失败路径没有对应文案。

### 改动

- [ ] 在三种语言（zh-CN / en / in）补文案，放在 `libraryBravaisHome` 或 `home` 命名空间：
  - `recommendFeedTimeout`：推荐流请求超时
  - `recommendFeedFailed`：推荐流暂时不可用
  - `recommendFeedEmpty`：该平台暂时没有更多推荐
  - `recommendFeedAuthExpired`：登录已过期，请重新登录
  - `recommendFeedAppended`：已追加 {{count}} 首
- [ ] `libraryHomeActions` 里把错误映射到提示：
  - `TimeoutError` → timeout 文案
  - `DOMException` 且 `name === 'AbortError'` → 静默取消，不提示
  - `OnlineProviderError` 的 auth/网络/限流 → 对应文案
  - 其他 → 通用失败
- [ ] 空批次：用户主动点击时提示一次 `recommendFeedEmpty`；队列自动续批为空时最多提示一次，避免每首歌都弹。
- [ ] 成功追加提示如果已有，统一带上实际追加数量；没有则补 `recommendFeedAppended`。
- [ ] 提示统一走 `port.notify({ kind:'status', type:'error'|'info', message })`，不要用 `window.alert`。

### 验收

- [ ] 模拟网络失败、超时、空批次、登录过期，分别出现正确提示。
- [ ] 切换平台导致的 `AbortError` 不弹错误。
- [ ] 同一轮自动续批不会连续刷屏。

### 测试

- [ ] `libraryHomeActions.test.ts`：失败时 `notices` 包含对应 key。
- [ ] `libraryHomeActions.test.ts`：`AbortError` 不产生 notice。
- [ ] `libraryHomeActions.test.ts`：空批次产生一次 info notice。

### 涉及文件

- [libraryHomeActions.ts](../src/library/core/services/libraryHomeActions.ts)
- [homeModel.ts](../src/library/core/contracts/homeModel.ts)
- `src/i18n/locales/zh-CN.ts`、`en.ts`、`in.ts`
- [createLibraryHomePort.ts](../src/library/app/createLibraryHomePort.ts)

### 风险

- 自动续批的提示需要节流；建议用一个「本 FM 会话只提示一次」的标记。

---

## P0-3 推荐按钮忙碌状态

### 目标

请求进行中，推荐流按钮有明确的加载/禁用状态，用户知道点击已被接收。

### 现状

- [BravaisHomeAction](../src/library/suites/bravais/bravaisHomeModels.ts) 只有 `id/label/title/icon/tone/run`，没有 `busy/disabled`。
- `libraryHomeActions` 的 snapshot 只记录导入/刷新/扫描，没有推荐流进行中状态。
- [BravaisHomeSources.tsx](../src/library/suites/bravais/BravaisHomeSources.tsx) 只用 ref 调用动作，不订阅 snapshot。

### 改动

- [ ] `LibraryHomeActionsSnapshot` 增加 `personalFmBusy: boolean`（或 `recommendFeedBusy`），`IDLE` 同步补字段。
- [ ] `playPersonalFm` / `loadMorePersonalFm` 开始时 `patch({ personalFmBusy:true })`，`finally` 置回 `false`。
- [ ] `BravaisHomeAction` 增加 `busy?: boolean`、`disabled?: boolean`。
- [ ] `BravaisHomeOnline` 订阅 `useLibraryHomeActions(homeActions)` 的 snapshot，把 busy 传给 `feedAction`；`feedAction` 的 memo 依赖补上 busy。
- [ ] [BravaisSeamHome.tsx](../src/library/suites/bravais/BravaisSeamHome.tsx) 的动作按钮：`disabled`、`aria-busy`、点击时不执行，busy 时显示转圈或 `.is-busy` 样式。
- [ ] [bravaisHome.css](../src/library/suites/bravais/bravaisHome.css) 增加忙碌/禁用样式。

### 验收

- [ ] 请求期间按钮显示忙碌且不可重复点击；完成后恢复。
- [ ] 键盘/读屏能读到忙碌与禁用状态。
- [ ] 切到其他平台时，忙碌状态不会错误地套在新平台按钮上。

### 测试

- [ ] `libraryHomeActions.test.ts`：pending 期间 `getSnapshot().personalFmBusy === true`，resolve 后为 `false`。
- [ ] 若有 Bravais 组件测试，补按钮 `aria-busy` / 禁用断言。

### 涉及文件

- [homeModel.ts](../src/library/core/contracts/homeModel.ts)
- [libraryHomeActions.ts](../src/library/core/services/libraryHomeActions.ts)
- [bravaisHomeModels.ts](../src/library/suites/bravais/bravaisHomeModels.ts)
- [BravaisHomeSources.tsx](../src/library/suites/bravais/BravaisHomeSources.tsx)
- [BravaisSeamHome.tsx](../src/library/suites/bravais/BravaisSeamHome.tsx)
- [bravaisHome.css](../src/library/suites/bravais/bravaisHome.css)

### 风险

- 订阅 snapshot 会增加重渲染；只订阅需要的字段，或沿用现有 `useLibraryHomeActions` 的选择器模式。

---

## P0-4 跨批次去重

### 目标

同一首歌不会在短时间内被推荐流反复推回来，即使它已经播完并离开当前队列。

### 现状

- 队列续批只和当前 `playQueue` 去重（[usePlaybackQueueController.ts](../src/hooks/usePlaybackQueueController.ts#L1086)）。
- `loadMorePersonalFm` 完全依赖队列侧去重。
- 没有跨启动的历史记录。

### 改动

- [ ] 新建 `src/services/onlineMusic/recommendationHistory.ts`：
  - 按 providerId 存储最近看到的歌曲 key，上限 300 首 / 7 天。
  - localStorage key 带版本，例如 `folia.recommendation.seen.v1:<providerId>`。
  - 提供 `filterUnseen(providerId, songs)`、`markSeen(providerId, songs)`、`clear(providerId)`。
  - 读写包 try/catch，localStorage 满或不可用时退化为内存集合。
- [ ] `playPersonalFm` 与 `loadMorePersonalFm` 取到结果后先过滤已见 key，再播放/入队；入队后标记。
- [ ] 队列自动续批同样过滤（历史 + 当前队列 + 本批内部），入队后标记。
- [ ] 如果过滤后为空：提示 `recommendFeedEmpty`；可选地清理最旧的一半历史后重试一次（最多一次）。
- [ ] 提供调试入口或命令面板动作清空推荐历史，方便用户「重新开始」。

### 验收

- [ ] 连续两批里出现同一首歌，第二批会被过滤掉。
- [ ] 重启应用后，同一平台的历史仍生效。
- [ ] 历史超过 300 首或 7 天后自动淘汰。
- [ ] 小平台推荐池很小时，不会因为过滤而永远为空；有重试/清理策略。

### 测试

- [ ] 新增 `test/unit/onlineMusic/recommendationHistory.test.ts`：TTL、上限、同 key 去重、localStorage 异常回退。
- [ ] `libraryHomeActions.test.ts`：第二批重复歌曲不进入 `enqueuePersonalFm`。
- [ ] `usePlaybackQueueController` 续批去重测试（如现有测试可扩展）。

### 涉及文件

- 新增 `src/services/onlineMusic/recommendationHistory.ts`
- [libraryHomeActions.ts](../src/library/core/services/libraryHomeActions.ts)
- [usePlaybackQueueController.ts](../src/hooks/usePlaybackQueueController.ts)
- [createLibraryHomePort.ts](../src/library/app/createLibraryHomePort.ts)（如需 providerId）

### 风险

- 过度过滤会让推荐变少；先只对「最近 7 天/300 首」生效，并提供清空入口。
- 多账号共用一个 provider 时，历史会混在一起；如果需要按账号隔离，key 里加账号 id（可后续做）。

---

## P0-5 QQ 推荐路由启动自检

### 目标

QQ 的 `/getPersonalFm` 路由注册失败时，不让用户看到一个点了必然失败的「推荐流」入口；账号和其他 QQ 功能不受影响。

### 现状

- [qqRecommendRoute.cjs](../electron/qqRecommendRoute.cjs#L153) 的 `registerQqPersonalFmRoute` 失败返回 `false` 或抛错。
- [qqApiStartup.cjs](../electron/qqApiStartup.cjs#L58) 在 `defaultLoadModule` 里捕获并 `console.warn`，没有把状态暴露给渲染层。
- `qqProvider` 的 `capabilities.personalFm` 是静态 `true`，UI 无法知道路由是否可用。

### 改动

- [ ] `qqApiStartup.cjs` 增加模块级状态：`'registered' | 'unavailable' | 'unknown'`，导出 `getQqPersonalFmRouteStatus()`。
- [ ] 通过现有 IPC/preload 增加只读查询（例如 `window.electron.getQqPersonalFmStatus()`），或在现有 backend status 广播里带一个字段。
- [ ] `qqProvider` 增加 `isPersonalFmAvailable()`（读取缓存的启动状态）；不可用时 `getPersonalFm` 直接抛 `OnlineProviderError('unsupported')`，不要发无效请求。
- [ ] [homeSources.ts](../src/library/core/model/homeSources.ts) 计算 `hasPersonalFm` 时同时看静态能力和运行时状态；不可用时首页不显示该按钮，或显示禁用态并给 title 说明。
- [ ] 应用启动后异步刷新一次状态；失败不阻塞启动。
- [ ] 保留现有 `defaultLoadModule` 的「不拖垮 QQ 后端」行为。

### 验收

- [ ] 模拟 `registerQqPersonalFmRoute` 返回 false：应用正常启动，QQ 登录/搜索可用，推荐流入口隐藏或禁用并说明原因。
- [ ] 正常注册时行为与现在一致。
- [ ] 状态刷新不会造成重复注册或端口重启。

### 测试

- [ ] `test/unit/electron/qqApiStartup.test.ts`：注册失败时 status 为 unavailable，启动不抛。
- [ ] `test/unit/onlineMusic/qqProvider.test.ts`：不可用时 `getPersonalFm` 抛 `unsupported`，不调用 transport。
- [ ] `homeSources` 相关测试：运行时不可用 → `hasPersonalFm:false`。

### 涉及文件

- [qqRecommendRoute.cjs](../electron/qqRecommendRoute.cjs)
- [qqApiStartup.cjs](../electron/qqApiStartup.cjs)
- `electron/main.cjs`、`electron/preload.cjs`（IPC 暴露）
- [qqProvider.ts](../src/services/onlineMusic/qqProvider.ts)
- [homeSources.ts](../src/library/core/model/homeSources.ts)
- [BravaisHomeSources.tsx](../src/library/suites/bravais/BravaisHomeSources.tsx)

### 风险

- 这是唯一跨主进程/渲染进程的任务，注意 IPC 只读、无副作用；不要把启动自检做成阻塞等待。
- `provider capabilities` 目前是静态对象；如果改造成运行时状态，注意所有读取方（搜索、账户、首页）一致。

---

## P0-6 窗口隐藏时暂停视觉器/壁纸采集

### 目标

普通播放窗口最小化、被遮挡或切到后台时，停止/降低视觉器与壁纸采集的渲染开销；恢复窗口后继续。

### 现状

- 视觉器代码里没有 `visibilitychange` / `document.hidden` 处理。
- Sonnet / Tempera 已有 `setPaused`，Lumiere 需要确认是否有等价 API。
- [WeBackgroundLayer.tsx](../src/components/visualizer/backgrounds/we/WeBackgroundLayer.tsx) 的采集 video 没有随页面隐藏暂停。
- 壁纸模式必须在桌面持续渲染，不能简单按 `document.hidden` 停掉。

### 改动

- [ ] 新建 `src/hooks/useDocumentVisibility.ts`（`useSyncExternalStore` 或事件监听），返回 `hidden`。
- [ ] 播放页计算 `effectivePaused = paused || (hidden && !isWallpaperMode)`。
- [ ] Sonnet / Tempera：把 `effectivePaused` 传给现有 `paused` prop（它们已有 `setPaused`）。
- [ ] Lumiere：确认 `createLumierePixiRuntime` 是否有 pause/ticker 控制；没有则补 `setPaused` 或在 host 层 stop ticker。
- [ ] Classic / DOM 歌词：给根节点加隐藏类，CSS 动画 `animation-play-state: paused`。
- [ ] 背景渲染器：把 `effectivePaused` 传给 shader/Canvas 背景；Latent/Sora/Nomand 等 RAF 循环在 paused 时停止。
- [ ] `WeBackgroundLayer` 增加 `paused` prop：隐藏时 `video.pause()` / 禁用采集 track；恢复时 `video.play()`。壁纸模式下不暂停。
- [ ] 可选：隐藏时把壁纸采集帧率降到 1fps，而不是完全停止，避免恢复时黑帧。
- [ ] 确保 `isWallpaperMode` 的判定来自现有桌面/壁纸状态，不要新造一套。

### 验收

- [ ] 普通播放窗口最小化 10 秒，CPU/GPU 占用明显下降；恢复后歌词和背景继续动。
- [ ] 壁纸模式下切走窗口，桌面壁纸仍持续渲染。
- [ ] 暂停/恢复不会导致 WebGL 上下文丢失或歌词空白。
- [ ] 切换视觉器/背景后，隐藏状态仍然正确。

### 测试

- [ ] 组件测试：模拟 `visibilitychange`，断言 Sonnet/Tempera 的 `setPaused` 被调用；恢复时调用 false。
- [ ] `WeBackgroundLayer` 测试：隐藏时 video.pause，恢复时 play；wallpaper 模式不 pause。
- [ ] 手动用任务管理器观察隐藏前后 GPU/CPU。

### 涉及文件

- 新增 `src/hooks/useDocumentVisibility.ts`
- [VisualizerShell.tsx](../src/components/visualizer/VisualizerShell.tsx)
- [VisualizerRenderer.tsx](../src/components/visualizer/VisualizerRenderer.tsx)
- [pixiRuntimeHost.ts](../src/components/visualizer/pixiRuntimeHost.ts)
- [WeBackgroundLayer.tsx](../src/components/visualizer/backgrounds/we/WeBackgroundLayer.tsx)
- `src/components/visualizer/backgrounds/*` 各 RAF 背景
- [classic/Visualizer.tsx](../src/components/visualizer/classic/Visualizer.tsx)

### 风险

- 壁纸模式与普通窗口共用视觉器，必须用现有 wallpaper mode 状态区分，避免把桌面壁纸停掉。
- 某些 GPU/驱动在暂停后恢复会闪一帧；用「暂停前渲染一帧」或保留最后画面缓解。

---

## 建议提交拆分

1. `fix(feed): 推荐请求超时并保证锁释放`
2. `fix(feed): 失败与空结果提示`
3. `feat(feed): 推荐按钮忙碌状态`
4. `feat(feed): 跨批次推荐去重`
5. `fix(qq): 推荐路由启动自检`
6. `perf(visualizer): 窗口隐藏时暂停渲染与采集`

每个提交单独跑 typecheck + 相关单测，最后统一跑全量。

## 发布前检查

- [ ] 五个平台各点一次推荐流，确认首次播放与连点追加
- [ ] 断网/超时/空结果/登录过期各模拟一次
- [ ] QQ 路由注册失败模拟一次（开发环境）
- [ ] 普通窗口最小化/恢复，壁纸模式切走/回来
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] 组件测试（推荐流按钮、视觉器暂停）
- [ ] 版本号 `0.3.4`，重新构建安装包
- [ ] 更新 `latest.yml` / blockmap 并上传 Release
