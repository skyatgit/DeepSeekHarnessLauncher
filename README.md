# DeepSeekHarnessLauncher

DeepSeekHarnessLauncher 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Windows 桌面启动器：一个 **Electron 托盘应用，环境全内置**。

它把「下载运行时 → 拉取源码 → 安装依赖 → 构建 → 启动 Web UI」整条流程自动化，用户**无需预装 Node.js、Git 或 pnpm**，双击即用。

- 仓库地址：https://github.com/skyatgit/DeepSeekHarnessLauncher
- 应用版本：`1.0.5`（Electron `44.0.0`，electron-builder `26.x`）
- 目标平台：Windows 10/11 **x64**（只发布 x64 安装包，因此**本项目只有「装安装包」这一种使用方式**，不再提供便携版；`main.js` 会按 `process.arch` 下载对应架构的便携运行时，ARM64 上可运行 x64 版本，但尚未提供原生 ARM64 安装包）
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
| 🧲 全局单实例 | 安装版 / 开发版互斥，同一时间只允许运行一个启动器，重复启动只唤起主面板；可接管**由本启动器启动**（`runtime\dsh.pid` 有记录）的 dsh 进程（停止 / 打开界面） |
| 🚪 灵活退出 | 退出时可选择「停止 dsh 并退出」或「保持 dsh 后台运行，仅退出启动器」 |
| 📴 离线可用 | GitHub 不可达时自动跳过更新检查，使用本地已就绪的环境离线运行 |

## 快速开始

### 直接使用（普通用户）

安装并运行本项目的安装包（`release\DeepSeekHarness-Setup-<版本>.exe`，双击安装；这是唯一的使用方式），安装完成后运行 `DeepSeekHarnessLauncher.exe`，系统托盘出现图标并自动打开主面板：

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
   开发态下程序根 = 项目根目录（`main.js` 自动识别部署态 `<安装目录>\resources\app` 与开发态源码根）；运行时数据（`runtime\`、`source\`、`data\`、`logs\` 等）都写入程序根目录；Chromium 用户数据固定写入 `%APPDATA%\DeepSeekHarnessLauncher\user-data`（安装版与开发版共享，见下文「单实例机制」）。

## 构建与打包

| 命令 | 说明 |
| --- | --- |
| `npm run dist` | 先清空 `release\`（`scripts\clean.js`），再用 electron-builder 打 NSIS 安装包（x64）到 `release\`：`DeepSeekHarness-Setup-1.0.5.exe`。**这是本项目唯一的分发方式**（便携版已移除：不再有 `dist\` 组装脚本与产物）；构建结束后自动清掉 `release\win-unpacked\`（electron-builder 的解包中间产物，里面是一份可直接双击运行的程序副本）与 `builder-debug.yml`，因此产物目录里只留**安装包 + 自动更新元数据**（`latest.yml` / `.blockmap`）。脚本内置 `--publish never`，本地打包不会误发布。可自定义安装目录（per-user），自动创建桌面 / 开始菜单快捷方式 |
| `npm run check`（等同 `npm test`） | 运行 `scripts\check.js` 做静态一致性自检：UI 元素 id、IPC 通道、snapshot / env 字段、打包文件清单、版本号、设置项文档、状态徽章、**工作流 YAML**、**安装器契约**、语法。任何一项对不上就以非零码退出，可直接当 CI 门禁。其中安装器契约校验包括：所有 `MessageBox` 带 `/SD`（静默升级不会永久阻塞）、`SetErrorLevel` 在 `Abort` 之前、安装器搬移/还原的数据目录与 `main.js` 写在程序根下的目录完全一致；并反向锁死「只发布 nsis 安装包」「不再出现便携组装脚本」「构建后清掉解包副本」「不再打开安装明细窗口」 |

### GitHub Actions 自动构建与发布

推送 `v*` 标签（如 `v1.0.5`）时，GitHub Actions 会自动在 `windows-latest` 上执行：`npm ci` → `npm run check`（一致性自检）→ **校验标签与 `package.json` 版本一致**（`scripts\check-tag.js`）→ 补齐 Electron 运行时 → `npm run dist`，并把生成的安装包发布到对应 tag 的 GitHub Release；也可在 Actions 页面手动触发构建（`workflow_dispatch`），产物作为构建工件下载。

> 工作流文件本身也在自检范围内：`npm run check` 会用 `js-yaml` 解析 `.github\workflows\*.yml`（报错带行号），并校验 `release.yml` 仍含「标签校验 / 构建 / 发布」三步。这条检查是补课来的——曾经把一段 `node -e` 脚本内联写成 `run:` 的值，脚本里的「标签与版本一致: 」含**冒号加空格**，在 YAML 里是映射分隔符，整个工作流被判 `Invalid workflow file`，本地却毫无察觉，直到打 tag 才失败。

发布流程：

1. 更新 `package.json` 的 `version`（安装包文件名带版本号，CI 会校验标签与它一致）；
2. 提交并推送；
3. 打标签前可本地预检（与 CI 同一条逻辑）：`node scripts/check-tag.js v1.0.5`；
4. 打标签并推送：`git tag v1.0.5 && git push origin v1.0.5`；
5. 等待 Actions 完成，Release 页面即可下载 `DeepSeekHarness-Setup-<version>.exe`。

> 提示：当前安装包未做代码签名，Windows SmartScreen 可能显示"未知发布者"提示，属预期现象。

### 安装包与升级

- 安装时可选择「所有用户 / 当前用户」与安装目录；选择装到 `C:\Program Files` 等受保护目录时，安装器在**安装阶段**请求管理员权限，并只把**数据目录**（`runtime\` / `config\` / `data\` / `logs\` / `source\` / `cache\`）授权给普通用户写入，程序目录本身只给「读取 + 执行」，**运行阶段无需管理员权限**；若授权失败安装器会明确警告。这样本机其他用户无法替换程序文件。
- 安装/升级界面与标准安装包一致：只有进度条，不显示文件操作明细。原因：electron-builder 把整个程序打成一个 `app-64.7z` 由插件整包解压（插件不打印任何行）、再用 `CopyFiles` 一次搬进安装目录，所以 NSIS 自带的明细窗口里只会出现 `Extract: app-64.7z…` 这类无意义的行；要拿到真正的逐文件信息必须接管 NSIS 模板，收益不值这个维护成本。安装过程中的关键结论（升级是否中止、数据是否恢复）通过 `UPGRADE-DATA-WARNING.txt` 与启动器日志告知。
- 检测到已安装时，再次运行安装包即为**升级**：不再提供目录与安装模式选择，强制沿用原安装目录与原安装模式，并自动保留全部运行数据（`runtime\` / `config\` / `data\` / `logs\` / `source\` / `cache\`）。数据暂存在 `%TEMP%` 再搬回，跨盘（`%TEMP%` 在别的卷）时自动改用递归复制；万一迁移或恢复失败，安装器会**中止升级并报错**，同时在安装目录写下 `UPGRADE-DATA-WARNING.txt`（记录暂存位置），启动器下次启动会把它显示到主面板日志里——不会静默丢数据。若暂存区里还留着**上次未搬回**的数据（例如上一次升级中途失败），安装器**不会再把它删掉**，而是同样中止升级并提示你先把残留目录搬回安装目录，确认无误后再重试。
- 升级前请先退出启动器（并停止 dsh），避免运行中的进程占用文件导致升级中止。**注意：只关闭主面板窗口只是隐藏到托盘，启动器仍在运行**——请从「托盘图标」的右键菜单选择「退出」（或主面板的「退出」按钮）。安装器现在会在动手之前先检测：若发现 `DeepSeekHarnessLauncher.exe` 仍在运行，会**在改动任何数据之前**中止并提示你先完全退出，不会再出现「备份失败」这类含糊报错。
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
│   ├── clean.js               # 打包前清空输出目录（npm run dist 的第一步）
│   ├── check.js               # 静态一致性自检（npm run check / npm test）
│   ├── check-tag.js           # 校验 Git 标签与 package.json 版本一致（CI 与本地预检共用）
│   └── installer-extra.nsh    # NSIS 安装器扩展（升级数据保留 / 卸载确认 / 目录授权）
├── release\                   # 安装包产物：每次 npm run dist 先清空，构建后只留安装包 + latest.yml / .blockmap
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
│   └── dsh.pid                # dsh 进程记录（PID / 时间 / 端口 / host / 入口地址，用于进程探测与恢复入口）
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

> `settings.json` 是唯一配置来源，可手动编辑。数值型字段接受数字或数字字符串（`"port": "4000"` 等价于 `4000`）；类型或取值确实非法的项（如 `"port": "abc"`、`"openBrowser": "yes"`、写成 URL 的 `host`）会回退到上表默认值，不会让启动流程出错。**改完不必重启启动器**：每次点「启动」或「检查并更新」都会重新读取该文件，改动立即生效。
>
> 改 `nodeVersion` / `pnpmVersion` 也是**安全**的：新版本会先下载/安装到暂存位置，确认可用后才替换现役运行时；下载失败或断网时旧版本原样保留，把版本号改回原值即可离线继续使用（不会出现「改错一个版本号就把可用环境删掉」的情况）。注意：环境已经就绪时，点「启动」会直接复用现成环境（不会再去核对运行时版本），所以**改 `nodeVersion` / `pnpmVersion` 后请用「检查并更新」来应用**。若该运行时**正被占用**，替换会在动手之前被拒绝，不会换到一半，也不会留下版本标记与实际运行时不一致的状态。占用者不一定是 dsh：后台运行的 dsh（只有启动器认不出它的记录时才会走到这一步——dsh 是从命令行手工启动的、`runtime\dsh.pid` 被手工删除、或记录已被当作残留清理而进程仍在跑）、另一个启动器实例正在安装依赖/构建、或启动器自身的环境探测，都可能短暂持有该文件；按提示**稍后重试**即可，若确实有 dsh 在运行则先停止它（只要启动器还认得出这条记录，「启动 / 检查并更新」本来就是灰的，根本走不到替换）。

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

启动器是**全局单实例**的：**安装版与开发版互斥**——同一时间只能运行一个，重复启动会自动唤起已在运行的实例。

实现要点：Electron 的单实例锁在 Windows 上按 userData 目录划作用域（`app.requestSingleInstanceLock()` 的参数只是传给首实例的 additionalData，并不是锁名），因此安装版与开发版共享同一份 Chromium 用户数据（`%APPDATA%\DeepSeekHarnessLauncher\user-data`），锁才能跨位置全局生效；这也意味着两者共享窗口大小/位置等界面状态。

### 进程管理边界

- 「停止」按 `runtime\dsh.pid` 记录的 PID 结束 dsh 进程；Windows 上 Node 只能终止单个进程，dsh 派生的子进程**不会被连带终止**，以更高权限或其它用户启动的实例也无法被普通权限的启动器结束。停止失败时启动器会**保持「运行中」状态并在主面板显示错误**，不会谎报已停止，也不会清掉 PID 记录。
- **PID 复用保护**：结束上次会话遗留的记录前，启动器要做两步核对——① 记录里的端口上**确实有服务在听**（先做绑定探测，再实连一次；这样即使用通配地址 `0.0.0.0:端口` 监听的别的程序也不会被误判成「端口空闲」）；② 用系统命令查该 PID 的**实际启动时间**，比记录时间晚 60 秒以上就说明原 dsh 早已退出、这个 PID 被系统复用给了别的程序，此时**绝不下手**，改为询问用户。端口明确空闲则只清理记录、绝不结束进程。这两步都是**反证式**证据（能证明「不是它」，但不能百分百证明「就是它」）；万一系统命令不可用（查不到启动时间），退回只按端口判定，此时理论上的残余风险是「PID 被复用、且新占用者恰好又在同一端口服务」，概率极低。
- 升级前写入的旧记录既没有 `host`，也可能没有端口：能按日志推算出地址就照常核对；**推不出来时不再直接结束该 PID**（那是旧版行为，Windows 复用 PID 时会误杀无关进程），而是和「地址不可监听」一样弹窗让你选。
- 记录里同时保存启动时使用的 `host`，所以改过 `settings.json` 的 `host` 再重启启动器，仍能认出在**旧地址**上运行的那个 dsh，既不会误清记录，也不会又起一个实例。（此保证适用于**本版本启动过**的 dsh；升级前遗留的旧记录没有 host 字段，只能按当前 `settings.host` 推断——若你恰好同时改过 host，那条旧记录仍可能被当成残留清掉，下次成功启动会重写记录，属一次性过渡问题。）
- 若记录里的地址已经不可监听（网卡 / VPN / 主机名变化），或旧记录里根本没有地址，或核对发现 PID 已被系统复用，启动器**既不会卡死、也不会擅自结束进程**：这几种状态下都无法证明那个 PID 仍是 dsh，误杀无关程序的代价更高，所以它会按「运行中」对待该记录，点「停止」时弹窗（写明具体原因）让你选「结束进程并清理记录 / 只清理记录（不结束进程）/ 取消」；退出启动器时同样不会结束这类无法确认身份的进程，记录留给下次处理。必要时也可手动删除 `runtime\dsh.pid`。
- **PID 记录不会因为运行时间长而过期**：只要记录的进程还活着就继续认它（早期版本按 24 小时丢弃记录，会把连续运行一天以上的 dsh 忘掉，导致停止谎报、再启动出现两个实例）。判断记录是否还有效一律看**端口是否仍在提供服务**（并配合上一条的启动时间核对）：端口空闲就按残留记录清理且不杀进程；端口在服务、且进程启动时间与记录相符，才允许停止。
- 启动器只接管**自己启动并留有 PID 记录**的 dsh；从命令行手工启动、或 `runtime\dsh.pid` 被删除的 dsh，启动器既不会接管也无法停止，此时再次「启动」会因默认端口被占用而落到 `+1` 端口，出现**两个 dsh 同时在跑**——请在任务管理器中结束多余的 node 进程。
- 等待 dsh 打印服务地址的上限为 **60 秒**（首次启动要加载整个插件树，实测可达 13 秒以上）；到点后先探测端口，确认没有服务在听才会判定失败并结束该进程。写成 URL 或带端口的 `host` 会按上文设置表回退到 `127.0.0.1`；填成**当前不可用的地址**（如已失效的局域网 IP、解析不了的主机名）才会报「无法在本机监听」并提示检查设置，而不是把 51 个端口全报成「被占用」。

## 常见问题

- **首次启动很慢？** 正常。首次运行需下载运行时（Node.js + MinGit + pnpm）并克隆、安装、构建整个 DeepSeek Harness，约 10~30 分钟，进度可在主面板日志与步骤条实时查看。
- **GitHub 连接失败？** 启动器会自动跳过更新检查并使用本地环境离线运行；若本地从未成功准备过环境，请检查网络或代理后重试。离线时点「检查并更新」会明确提示「未能检查更新」，不会谎报「已是最新版本」。
- **卡在「启动服务」很久？** 正常范围内。首次启动要加载整个插件树，启动器最多等待 60 秒 dsh 打印服务地址；到点后会先探测端口，确认确实没有服务在听才判定失败。
- **日志会越来越大吗？** 不会。`logs\launcher.log` 超过 5 MB 会自动轮转为 `launcher.log.1`（旧的 `.1` 顺延为 `.2`，更早的丢弃），正常情况最多占用约 15 MB；查看日志文件夹即可看到最多三份文件。启动时只回读日志尾部，并在当前日志里找不到服务地址时依次回退到 `.1` / `.2`；启动器自己启动的 dsh 还会把入口地址（含 token）写进 `runtime\dsh.pid`，所以即使 dsh 连续运行到日志早已轮转，重启启动器后「打开 Web UI」依然可用。
- **端口被占用？** 启动器会自动从 `settings.json` 的 `port` 起向后探测可用端口（最多 +50），无需手动处理。探测同时做「绑定 + 实连」两步：Windows 允许在别人已监听 `0.0.0.0:端口` 时本机再绑 `127.0.0.1:端口`（绑定成功并不代表端口空闲），实连一步能把这种情况识别出来并跳到下一个端口，避免两个服务共用同一个端口号。
- **想彻底重置？** 退出启动器后，按上文「环境信息与环境重置」手动删除对应目录即可回到首次安装状态。
- **同时运行了两个启动器？** 单实例锁按用户会话生效：请确认两个实例都以**同一 Windows 用户、相同的权限级别**运行（一个以管理员运行、另一个普通运行时会绕过互斥体，属 Windows 安全边界）。

## 相关链接

- DeepSeek Harness 仓库：https://github.com/deepseek-ai/deepseek-harness
- DeepSeek Harness 文档：https://deepseek-harness.github.io/deepseek-harness/
- Web UI 使用指南：`source\deepseek-harness\docs\user\guide\index.md`

## 许可证

本启动器以 [MIT](./LICENSE) 协议开源；DeepSeek Harness 本体同样以 [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) 协议开源。
