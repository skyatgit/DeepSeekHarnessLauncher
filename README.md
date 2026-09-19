# DeepSeekHarnessLauncher

DeepSeekHarnessLauncher 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Windows 桌面启动器：一个 **Electron 托盘应用，环境全内置**。

它把「下载运行时 → 拉取源码 → 安装依赖 → 构建 → 启动 Web UI」整条流程自动化，用户**无需预装 Node.js、Git 或 pnpm**，双击即用。

- 仓库地址：https://github.com/skyatgit/DeepSeekHarnessLauncher
- 应用版本：`1.0.2`（Electron `44.0.0`，electron-builder `26.x`）
- 目标平台：Windows 10/11 **x64**（当前只发布 x64 安装包与便携版；`main.js` 会按 `process.arch` 下载对应架构的便携运行时，ARM64 上可运行 x64 版本，但尚未提供原生 ARM64 安装包）
- 被启动的目标：[`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness)（默认分支 `master`）

---

## 功能特性

| 特性 | 说明 |
| --- | --- |
| 🚀 一键启动 | 点击「启动」自动完成全部准备工作并启动 `dsh web`；首次运行约 10~30 分钟，之后直接启动 |
| 🏗️ 构建产物启动 | 构建完成后通过构建产物入口 `apps/cli/lib/bin.js`（即 npm 包发布的正式入口）启动 dsh，无需 tsx 现场转译，启动更快；仅当构建产物缺失时回退到 `apps/cli/src/bin.ts` 源码入口兜底 |
| 📦 环境全内置 | 自动下载并管理**便携版** Node.js `22.23.2`、Git（MinGit `2.55.0`）、pnpm `11.7.0`，全部放在程序目录内，不污染系统环境 |
| 🔄 一键更新 | 「检查并更新」对比远程分支，`fetch + reset --hard` 更新源码后自动清理旧编译产物、重装依赖、重新构建 |
| 🖥️ 系统托盘 | 托盘菜单实时显示状态，可启动 / 停止 / 更新 / 打开 Web UI / 打开日志 / 退出 |
| 📊 主面板 | 实时状态徽章、监听地址、Web UI 链接、最近活动、错误信息、**节点式任务步骤条**（准备环境 → 拉取源码 → 安装依赖 → 构建 → 启动，实时显示当前步骤）、完整运行日志 |
| 🧰 环境总览 | 环境依赖清单**两列**展示（Node.js / Git / pnpm / 源码 / 依赖 / 用户数据 / 设置 / 缓存），显示就绪状态、版本与路径，点击路径直达资源管理器 |
| 🔌 端口自动避让 | 默认端口（`3080`）被占用时自动向后探测可用端口（最多 +50） |
| ⚡ 开机自启 | 支持「开机自启」与「启动器启动时自动运行 dsh」两个独立开关 |
| 🧲 全局单实例 | 安装版 / 便携版 / 开发版互斥，同一时间只允许运行一个启动器，重复启动只唤起主面板；可接管**由本启动器启动**（`runtime\dsh.pid` 有记录）的 dsh 进程（停止 / 打开界面） |
| 🚪 灵活退出 | 退出时可选择「停止 dsh 并退出」或「保持 dsh 后台运行，仅退出启动器」 |
| 📴 离线可用 | GitHub 不可达时自动跳过更新检查，使用本地已就绪的环境离线运行 |

## 快速开始

### 直接使用（普通用户）

运行 `DeepSeekHarnessLauncher.exe`（`dist\` 构建产物或 NSIS 安装包），系统托盘出现图标并自动打开主面板：

1. 点击 **「启动」**：
   - **首次运行**：自动下载便携版 Node.js / Git / pnpm → 克隆 DeepSeek Harness 源码 → `pnpm install` → 构建（宿主库 / 客户端库 / Web 前端），全程在主面板实时显示进度（节点式步骤条同步推进）；
   - **之后运行**：环境已就绪，直接启动服务。
2. 服务就绪后，主面板显示 Web UI 链接，默认地址为 `http://127.0.0.1:3080`，点击即可打开（也可通过托盘菜单「打开 Web UI」）。

> 提示：关闭主面板窗口只是隐藏到托盘，启动器会继续在后台运行；如需真正退出，请使用托盘菜单或主面板的「退出」。

### 从源码运行（开发）

1. 安装 Node.js（仅开发需要，最终用户无需）：
   ```sh
   npm install
   ```
2. 启动：
   ```sh
   npm run start      # 即 electron .
   ```
   开发态下程序根 = 项目根目录（`main.js` 会自动识别部署态 `dist\resources\app` 与开发态源码根）；运行时数据（`runtime\`、`source\`、`data\`、`logs\` 等）都写入程序根目录；Chromium 用户数据固定写入 `%APPDATA%\DeepSeekHarnessLauncher\user-data`（所有版本共享，见下文「单实例机制」）。

## 构建与打包

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 运行 `scripts\build.js`：组装 `dist\`——复制 Electron 运行时、重命名 `DeepSeekHarnessLauncher.exe`、把 6 个源文件拷入 `resources\app\`、备份并还原运行数据（`runtime\`/`cache\`/`data\`/`config\`/`logs\`/`source\`，重建不清空环境；中途失败会把数据放回 `dist\`，不会留在 `%TEMP%`）、用 `rcedit` 写入 exe 图标与**版本信息**（产品名/文件版本等，与安装版一致）。产物 `dist\` 即自带运行时的可分发版本 |
| `npm run dist` | 先清空 `release\`（`scripts\clean.js`），再用 electron-builder 打 NSIS 安装包（x64）到 `release\`：`DeepSeekHarness-Setup-1.0.2.exe`。产物目录只保留本次构建结果，不会残留旧版本安装包；脚本内置 `--publish never`，本地打包不会误发布。可自定义安装目录（per-user），自动创建桌面 / 开始菜单快捷方式 |
| `npm run check`（等同 `npm test`） | 运行 `scripts\check.js` 做静态一致性自检：UI 元素 id、IPC 通道、snapshot / env 字段、打包文件清单、版本号、设置项文档、状态徽章、语法。任何一项对不上就以非零码退出，可直接当 CI 门禁 |

### GitHub Actions 自动构建与发布

推送 `v*` 标签（如 `v1.0.2`）时，GitHub Actions 会自动在 `windows-latest` 上执行：`npm ci` → `npm run check`（一致性自检）→ 校验**标签与 `package.json` 版本一致** → 补齐 Electron 运行时 → `npm run dist`，并把生成的安装包发布到对应 tag 的 GitHub Release；也可在 Actions 页面手动触发构建（`workflow_dispatch`），产物作为构建工件下载。

发布流程：

1. 更新 `package.json` 的 `version`（安装包文件名带版本号，CI 会校验标签与它一致）；
2. 提交并推送；
3. 打标签并推送：`git tag v1.0.2 && git push origin v1.0.2`；
4. 等待 Actions 完成，Release 页面即可下载 `DeepSeekHarness-Setup-<version>.exe`。

> 提示：当前安装包未做代码签名，Windows SmartScreen 可能显示"未知发布者"提示，属预期现象。

### 安装包与升级

- 安装时可选择「所有用户 / 当前用户」与安装目录；选择装到 `C:\Program Files` 等受保护目录时，安装器在**安装阶段**请求管理员权限，并只把**数据目录**（`runtime\` / `config\` / `data\` / `logs\` / `source\` / `cache\`）授权给普通用户写入，程序目录本身只给「读取 + 执行」，**运行阶段无需管理员权限**；若授权失败安装器会明确警告。这样本机其他用户无法替换程序文件。
- 检测到已安装时，再次运行安装包即为**升级**：不再提供目录与安装模式选择，强制沿用原安装目录与原安装模式，并自动保留全部运行数据（`runtime\` / `config\` / `data\` / `logs\` / `source\` / `cache\`）。数据暂存在 `%TEMP%` 再搬回，跨盘（`%TEMP%` 在别的卷）时自动改用递归复制；万一恢复失败会提示暂存目录位置，不会静默丢数据。
- 升级前请先退出启动器（并停止 dsh），避免运行中的进程占用文件导致升级中止。
- ⚠️ **卸载会删除数据**：走「应用和功能」卸载时，安装目录下的 `runtime\`、`source\`、`data\`（会话 / 配置 / API 密钥）、`config\`、`logs\`、`cache\` 会一并删除。安装器会弹确认框，请在确认前先手动备份需要保留的目录。

## 目录结构

### 源码项目（本仓库）

```
DeepSeekHarnessLauncher\
├── main.js                    # 主进程：环境准备 / 源码更新 / 构建 / 启动 / 停止 / 托盘
├── preload.js                 # 渲染进程安全桥接（白名单 IPC API）
├── renderer.js                # 主面板渲染逻辑（含节点式步骤条）
├── index.html                 # 主面板界面
├── app.ico                    # 应用图标
├── package.json               # 应用清单与 electron-builder 构建配置
├── package-lock.json          # 依赖锁定（CI 用 npm ci）
├── LICENSE                    # MIT 许可
├── .gitattributes / .editorconfig  # 统一换行符（LF）与缩进
├── .github\workflows\release.yml   # 打 tag 自动构建并发布安装包
├── scripts\
│   ├── build.js               # 组装 dist\（npm run build）
│   ├── clean.js               # 打包前清空输出目录（npm run dist 的第一步）
│   ├── check.js               # 静态一致性自检（npm run check / npm test）
│   └── installer-extra.nsh    # NSIS 安装器扩展（升级数据保留 / 卸载确认 / 目录授权）
├── dist\                      # 构建产物（运行时生成）：自带 Electron 运行时的可分发版本
├── release\                   # 安装包产物（每次 npm run dist 先清空，只留本次结果）
├── runtime\  source\  data\  config\  logs\  cache\
│                              # 运行数据（运行时自动生成，见下表）
└── .gitignore
```

### 运行数据（部署后位于程序根目录内）

```
<程序根>\
├── runtime\                   # 便携运行时（自动生成）
│   ├── node\                  # 便携版 Node.js
│   ├── git\                   # 便携版 Git（MinGit）
│   ├── pnpm\                  # pnpm
│   ├── pnpm-store\            # pnpm 全局存储
│   ├── home\                  # 构建进程的 HOME / USERPROFILE
│   └── dsh.pid                # dsh 进程记录（用于进程探测）
├── source\                    # DeepSeek Harness 源码（git clone）
│   ├── deepseek-harness\
│   └── .built-sha             # 已构建源码的提交标记（避免重复构建）
├── config\settings.json       # 启动器设置（首次运行自动生成）
├── data\                      # 用户数据（DSH_HOME：会话 / 配置 / 密钥）
├── cache\                     # 下载缓存（安装包 / npm 缓存）
└── logs\launcher.log          # 运行日志（超过 5 MB 自动轮转为 launcher.log.1 / .2）
```

Chromium 用户数据（窗口状态等）不放在程序目录，固定存放于 `%APPDATA%\DeepSeekHarnessLauncher\user-data`。

## 设置（`config\settings.json`）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `nodeVersion` | `22.23.2` | 便携版 Node.js 版本 |
| `nodeBase` | `https://nodejs.org/dist` | Node.js 下载源 |
| `pnpmVersion` | `11.7.0` | pnpm 版本 |
| `mingitUrl` | MinGit 2.55.0 官方下载地址 | 便携版 Git 下载源 |
| `repoUrl` | `https://github.com/deepseek-ai/deepseek-harness.git` | 源码仓库 |
| `branch` | `master` | 跟踪的分支 |
| `npmRegistry` | `https://registry.npmjs.org/` | npm 镜像源 |
| `host` / `port` | `127.0.0.1` / `3080` | `dsh web` 监听地址与起始端口 |
| `updateCheck` | `auto` | 启动时自动检查更新（`off` 关闭） |
| `openBrowser` | `true` | 服务启动后自动打开浏览器 |
| `autoStartDsh` | `false` | 启动器启动时自动运行 dsh |

> `settings.json` 是唯一配置来源，可手动编辑。数值型字段接受数字或数字字符串（`"port": "4000"` 等价于 `4000`）；类型或取值确实非法的项（如 `"port": "abc"`、`"openBrowser": "yes"`、写成 URL 的 `host`）会回退到上表默认值，不会让启动流程出错。

## 环境信息与环境重置

主面板的「环境依赖」列表以**两列**展示各项环境的就绪状态、版本与路径，点击路径可在资源管理器中打开（仅限程序目录内）。

启动器**不提供删除环境的功能**：需要删除或重置某项环境时，请先退出启动器，再手动删除程序目录下对应的文件夹，下次启动会自动重新下载安装：

| 要重置的内容 | 删除的目录 |
| --- | --- |
| Node.js / Git / pnpm 运行时 | `runtime\` |
| 源码与构建产物 | `source\` |
| 用户数据（会话 / 配置 / 密钥） | `data\` |
| 启动器设置 | `config\` |
| 下载缓存 | `cache\` |
| 全部重置 | 删除 `runtime\`、`source\`、`data\`、`config\`、`cache\` |

> ⚠️ `data\`（DSH_HOME）包含所有会话、配置与密钥，手动删除前请务必确认。

## 源码更新与构建产物清理

- 启动时（`updateCheck: auto`）与「检查并更新」都会对比远程 `master` 分支，有新提交则 `fetch + reset --hard` 更新。
- 由于 `git reset --hard` 只同步受版本管理的文件，**每次更新后启动器会自动清理上一版本的编译产物**（源码树下的全部 `lib\` / `dist\` 目录与 `*.tsbuildinfo` 文件，跳过 `node_modules`、`.git` 与符号链接/junction），避免旧产物污染新版本构建（曾因此类残留导致 MISSING_EXPORT 构建失败）。
- 若构建仍异常，可删除 `source\` 目录后重新启动，进行干净的重新克隆与构建。

## dsh 的启动入口

构建产物就是启动产物，启动器按以下优先级选择入口（`cwd` 均为 `source\deepseek-harness`）：

| 优先级 | 入口 | 说明 |
| --- | --- | --- |
| 1（默认） | `apps/cli/lib/bin.js` | 构建产物；`apps/cli/package.json` 的 `bin` 字段即指向它，也是发布到 npm 的正式入口，纯 JS 无需转译 |
| 2（兜底） | `apps/cli/src/bin.ts`（`node --import tsx/esm`） | 仅当 `lib\bin.js` 不存在时使用；此时会在日志打印「启动方式: 源码 tsx ...」 |

判定与保障：`isEnvReady()` 与启动流程都会检查 `apps/cli/lib/bin.js` 是否存在，缺失则重新执行构建；因此正常路径下 dsh 始终由构建产物启动。反之，工作区内的各插件包（`packages/*/*`）**本来就只能由构建产物提供**——它们的 `exports` 指向 `lib/index.js`，源码启动同样依赖这些产物，`pnpm run build` 不可省略。

## 单实例机制

启动器是**全局单实例**的：**安装版、便携版与开发版互斥**——同一时间只能运行一个，重复启动会自动唤起已在运行的实例。

实现要点：Electron 的单实例锁在 Windows 上按 userData 目录划作用域（`app.requestSingleInstanceLock()` 的参数只是传给首实例的 additionalData，并不是锁名），因此所有版本共享同一份 Chromium 用户数据（`%APPDATA%\DeepSeekHarnessLauncher\user-data`），锁才能跨位置全局生效；这也意味着各版本共享窗口大小/位置等界面状态。

### 进程管理边界

- 「停止」按 `runtime\dsh.pid` 记录的 PID 结束 dsh 进程；Windows 上 Node 只能终止单个进程，dsh 派生的子进程**不会被连带终止**，以更高权限或其它用户启动的实例也无法被普通权限的启动器结束。停止失败时启动器会**保持「运行中」状态并在主面板显示错误**，不会谎报已停止，也不会清掉 PID 记录。
- **PID 复用保护**：结束上次会话遗留的记录前，启动器会先确认该记录里的端口仍在提供服务。这是**启发式证据而非 PID 身份证明**（纯 Node 无法反查端口属主），但足以挡住绝大多数「PID 被复用后误杀无关进程」的情况；端口明确空闲就只清理记录、绝不下杀手。升级前写入的旧记录没有端口信息：能按日志推算出端口就照常校验，推不出来才退回旧行为（直接结束该 PID）。
- 若因 `host` 填成了本机不可用的地址而无法探测，启动时会显示「无法确认 dsh 状态」的错误并保留记录，停止也会报错而不是误清。
- 启动器只接管**自己启动并留有 PID 记录**的 dsh；从命令行手工启动的、或 PID 记录超过 24 小时（按残留记录清理）的 dsh，启动器既不会接管也无法停止，此时再次「启动」会因默认端口被占用而落到 `+1` 端口，出现**两个 dsh 同时在跑**——请在任务管理器中结束多余的 node 进程。
- 等待 dsh 打印服务地址的上限为 **60 秒**（首次启动要加载整个插件树，实测可达 13 秒以上）；到点后先探测端口，确认没有服务在听才会判定失败并结束该进程。写成 URL 或带端口的 `host` 会按上文设置表回退到 `127.0.0.1`；填成**当前不可用的地址**（如已失效的局域网 IP、解析不了的主机名）才会报「无法在本机监听」并提示检查设置，而不是把 51 个端口全报成「被占用」。

## 常见问题

- **首次启动很慢？** 正常。首次运行需下载运行时（Node.js + MinGit + pnpm）并克隆、安装、构建整个 DeepSeek Harness，约 10~30 分钟，进度可在主面板日志与步骤条实时查看。
- **GitHub 连接失败？** 启动器会自动跳过更新检查并使用本地环境离线运行；若本地从未成功准备过环境，请检查网络或代理后重试。离线时点「检查并更新」会明确提示「未能检查更新」，不会谎报「已是最新版本」。
- **卡在「启动服务」很久？** 正常范围内。首次启动要加载整个插件树，启动器最多等待 60 秒 dsh 打印服务地址；到点后会先探测端口，确认确实没有服务在听才判定失败。
- **日志会越来越大吗？** 不会。`logs\launcher.log` 超过 5 MB 会自动轮转为 `launcher.log.1`（旧的 `.1` 顺延为 `.2`，更早的丢弃），正常情况最多占用约 15 MB；查看日志文件夹即可看到最多三份文件。启动时只回读日志尾部，并在当前日志里找不到服务地址时依次回退到 `.1` / `.2`，因此轮转不会影响「打开 Web UI」。
- **端口被占用？** 启动器会自动从 `settings.json` 的 `port` 起向后探测可用端口（最多 +50），无需手动处理。
- **想彻底重置？** 退出启动器后，按上文「环境信息与环境重置」手动删除对应目录即可回到首次安装状态。
- **同时运行了两个启动器？** 单实例锁按用户会话生效：请确认两个实例都以**同一 Windows 用户、相同的权限级别**运行（一个以管理员运行、另一个普通运行时会绕过互斥体，属 Windows 安全边界）。

## 相关链接

- DeepSeek Harness 仓库：https://github.com/deepseek-ai/deepseek-harness
- DeepSeek Harness 文档：https://deepseek-harness.github.io/deepseek-harness/
- Web UI 使用指南：`source\deepseek-harness\docs\user\guide\index.md`

## 许可证

本启动器以 [MIT](./LICENSE) 协议开源；DeepSeek Harness 本体同样以 [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) 协议开源。
