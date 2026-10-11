<div align="center">

# Folia 二创版 · 加入汽水音乐音源

**folia-qishui** —— 在 [Folia](https://github.com/chthollyphile/folia-major) 的基础上二次创作，新增「汽水音乐」在线音源。

[上游项目](https://github.com/chthollyphile/folia-major) ｜ [许可证 AGPL-3.0](./LICENSE) ｜ [上游原始 README](./README.original.md)

</div>

---

## 一、这是什么

这是 Folia 的一个**二创分支**。Folia 是一个以全屏沉浸式歌词播放为核心的在线音乐播放器，支持网易云、酷狗、Navidrome 和本地音乐库，提供 Electron 桌面端（Windows / macOS / Linux）与 Node.js Web 端。

本仓库 = **上游 v0.7.17 的完整源码** + 下面这三处改动：

| # | 改动 | 说明 |
|---|------|------|
| 1 | **汽水音乐音源** | 新增「汽水音乐（SodaMusic）」在线音源：搜索、歌单、播放、歌词、扫码登录 |
| 2 | **QQ 歌词接口加固** | QQ 歌词接口返回 `code 2001`（被风控/限流）时的重试与降级，不再直接给空结果 |
| 3 | **酷狗依赖 vendor 化** | 把 `KuGouMusicApi` 改为仓库内 `vendor/` 依赖，新增 `qrcode` 依赖与原生模块的 `asarUnpack` 打包配置 |

除这三处以外，其余代码与上游保持一致。

## 二、与原作者、与开源协议

- 本项目基于 **chthollyphile** 的开源项目 [folia-major](https://github.com/chthollyphile/folia-major) 二次创作，**已与原作者进行过交流**。
- 遵循上游的 **AGPL-3.0** 许可证（全文见 [LICENSE](./LICENSE)）。

  > 注意：是 **AGPL-3.0**（GNU Affero General Public License v3），**不是 GPL-3.0**。AGPL 比 GPL 多一条约束：如果把修改后的程序作为**网络服务**提供给他人使用，也必须向使用者提供完整源码。

- 上游的原始 README 原封不动保留在 [README.original.md](./README.original.md)；上游的文档、贡献者名单、CI 配置等也都保留在仓库里。
- 本仓库**不包含任何**个人账号、Cookie、Token、API Key；源码里也没有任何本机路径。测试用例中的账号 ID 已替换为占位符。

## 三、汽水音乐音源是怎么接进去的（原理）

一句话：**签名交给官方组件，解密自己写，最后套一层「翻译」把音源注册进播放器。**

1. **协议层** —— `electron/qishui/qishui-api.js`
   把汽水的接口（搜索、歌单、播放地址、歌词、用户信息）封装成内部协议。所有对外请求只从 `requestOfficial` 这一个出口出去。

2. **签名宿主** —— `electron/qishui/qishui-auth-v6.js` + `electron/qishui/qishui-auth-v6/`
   主进程里开一个**隐藏窗口**，加载汽水官方的 Web 安全组件（官方 `bdms.js` 与原生模块 `bdms.node`、`metasecml.dll`），由它生成 `X-Helios` / `X-Medusa` 等签名头。出口白名单只放行 `api.qishui.com` 与 `api5-lq.qishui.com`，签名机不会被当成通用代理。

3. **音频解密 + 本地回环代理** —— `electron/qishuiApiBridge.cjs` + `electron/qishui/qishui-audio-decryptor/`
   汽水返回的是**密文音频**，解密钥藏在播放地址的 `#auth=` 里。程序在本机起一个只绑定 `127.0.0.1`、端口随机、路径带随机令牌的小代理：边拉密文边用 **AES-128-CTR** 解密，并按 `Range` 请求返回 `206`。播放器拿到的就是一个普通音频地址。

4. **适配层** —— `src/services/onlineMusic/qishui*.ts` + `src/hooks/useQishuiLibrary.ts`
   实现 Folia 的音源接口（搜索 / 歌单 / 播放 / 歌词 / 账户），在 `providerRegistry.ts` 里注册一行，界面上就自动长出汽水音源与对应按钮。

## 四、汽水音源功能一览

| 能力 | 状态 | 说明 |
|------|------|------|
| 搜索歌曲 | ✅ | 关键词搜索，返回歌曲 / 歌手 / 专辑 / 时长 |
| 播放 | ✅ | 走本机回环代理解密，支持拖动进度条（Range 请求） |
| 歌单 / 收藏 | ✅ | 读取账号下的歌单与收藏 |
| 歌词 | ✅ | 逐字歌词，含翻译 |
| 扫码登录 | ✅ | 用汽水 App 扫码；登录凭据只保存在本机 |
| 音质档位 | ✅ | standard / exhigh / lossless / hires / atmos 五档，按官方 `qualitymap` 逐曲判定 VIP |
| QQ 歌词 2001 | ✅ | 被限流时自动重试，仍失败则优雅降级为空结果 |

## 五、安装（普通用户）

**方式 A：安装包（Windows）**

1. 到本仓库的 **Releases** 页面下载 `Folia_Setup.exe`。
2. 双击运行，向导里选「仅为我安装」，安装目录保持默认（`E:\Folia` 或程序建议的目录）即可。
3. 装完会自动启动。首次打开时在音源列表里选「汽水音乐」，点登录，用汽水 App 扫码。

> ⚠️ **重要**：Folia 官方版的自动更新会把 `resources\app` 目录替换回它自己的 `app.asar`，**汽水音源会随之消失**。这不是 bug —— 更新后重新安装本安装包即可恢复。

**方式 B：绿色版**

解压官方发布页的 `Folia-<版本>-x64.zip`（或本仓库 Release 中的绿色包），直接运行 `Folia.exe`。

## 六、从源码构建（开发者）

前置条件：**Node.js ≥ 24**（见 `package.json` 的 `engines`），Windows / macOS / Linux。

```bash
# 1) 安装依赖
#    注意：本仓库的 package-lock.json 与 package.json 存在漂移（CI 用 npm ci 会报 EUSAGE），
#    请使用 install，不要用 ci。
npm install

# 2) 开发模式（浏览器）
npm run dev

# 3) 开发模式（Electron 桌面端，需先准备好本机原生产物，见 package.json 里的脚本）
npm run dev:electron

# 4) 只构建前端产物（Electron 打包前必须先做这一步）
#    ELECTRON=true 是关键：不设置的话产物用 file:// 绝对路径，加载时会白屏。
npx cross-env ELECTRON_DEV=false ELECTRON=true vite build

# 5) 打桌面安装包（需要 electron-builder；Windows 上还要先构建 windowtolayer / wallpaper-helper）
npm run build:electron
```

测试与检查：

```bash
npm run test:unit     # vitest 单元测试
npm run typecheck     # TypeScript 类型检查
```

## 七、使用说明

1. 打开 Folia → 在音源列表里选择「汽水音乐」。
2. 点「登录」→ 弹出二维码 → 用手机上的汽水 App 扫码授权。
3. 登录后即可搜索、播放、加载歌单与歌词。

**登录凭据存在哪里？**
Windows：`%APPDATA%\Folia`；macOS：`~/Library/Application Support/Folia`。这些文件是**明文**，只在你自己的机器上，**不要提交、不要外发**。

**常见问题**

- **播放无声 / 报解码错误**：确认 `resources/app/electron/qishui/qishui-auth-v6/bdms.node` 与同目录的 `metasecml.dll` 存在；打包时这两个文件必须 `asarUnpack`，否则原生模块加载失败。
- **搜索报 `code 2001`**：汽水侧风控限流。本仓库已加重试与降级（重试一次后仍失败则返回空结果，不再抛错）。
- **官方更新后音源消失**：见第五节注意事项，重新安装/重新构建即可。
- **`npm ci` 报 `EUSAGE: ... in sync`**：锁文件与 package.json 漂移，用 `npm install`。

## 八、改动速查

**新增（主进程）**

```
electron/qishui/qishui-api.js              汽水协议层
electron/qishui/qishui-auth-v6.js          签名宿主（隐藏窗口 + 出口白名单）
electron/qishui/qishui-auth-v6/            官方组件资产（bdms.js / bdms.node / metasecml.dll …）
electron/qishui/qishui-qr-login.js         扫码登录
electron/qishui/credentials.cjs            凭据读写（明文，仅本机）
electron/qishui/qishui-audio-decryptor/    AES-128-CTR 解密器（含 MP4 box / stco-stsc 解析）
electron/qishuiApiBridge.cjs               IPC 桥 + 本机回环音频代理
```

**新增（渲染层）**

```
src/services/onlineMusic/qishuiTransport.ts
src/services/onlineMusic/qishuiNormalize.ts
src/services/onlineMusic/qishuiProvider.ts
src/services/onlineMusic/qishuiCatalog.ts
src/services/onlineMusic/qishuiLibrary.ts
src/services/onlineMusic/qishuiMutations.ts
src/hooks/useQishuiLibrary.ts
src/utils/qrLoginDiagnosticReport.ts       扫码诊断（可选）
```

**接线改动**

`src/services/onlineMusic/providerRegistry.ts`（注册音源）、`src/App.tsx`、`electron/main.cjs`、`electron/preload.cjs`、`src/i18n/locales/*`、`src/library/core/model/accountRules.ts`、`src/vite-env.d.ts`、`package.json` / `package-lock.json`。

**QQ 歌词加固**

`src/utils/lyrics/providers/qqLyricProvider.ts`

## 九、免责声明

- 本项目仅供**个人学习与技术研究**使用。音乐版权归各平台及版权方所有，请勿用于商业用途或大规模分发。
- 汽水音源依赖汽水官方的**闭源** Web 安全组件（`bdms.node` / `metasecml.dll`）。官方随时可能改动签名协议，届时该音源可能失效。
- 本项目与汽水音乐、腾讯音乐、酷狗音乐等平台均无任何关联，也未获得其授权。
- 使用本软件产生的一切后果由使用者自行承担。

## 十、致谢

- [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) 以及所有贡献者 —— 本项目的全部基础。
- 上游 README 中列出的所有开源依赖与素材作者。
