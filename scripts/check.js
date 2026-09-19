// 静态一致性自检：npm run check
// 覆盖那些「改了一处忘了另一处」才会暴露的跨文件契约：
// UI 元素 id / IPC 通道与载荷 / snapshot 与 env 字段 / 打包文件清单 / 版本号 /
// 设置项文档 / 状态徽章与样式 / 语法
// 任何一项不一致都会以非零码退出，可直接作为 CI 门禁。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.join(__dirname, '..')
const problems = []
const notes = []

function read(p) { return fs.readFileSync(path.join(root, p), 'utf8') }
function fail(msg) { problems.push(msg) }

const html = read('index.html')
const renderer = read('renderer.js')
const preload = read('preload.js')
const main = read('main.js')
const readme = read('README.md')
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))

// ---------- 1. UI 元素 id ----------
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
// 两种等价写法都算取用：$('x') 与 document.getElementById('x')
const usedIds = [...renderer.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)].map((m) => m[1] || m[2])
for (const id of new Set(usedIds)) if (!htmlIds.has(id)) fail(`renderer.js 取用了 index.html 中不存在的 id: ${id}`)
for (const id of htmlIds) if (!usedIds.includes(id)) fail(`index.html 定义了但 renderer.js 未使用的 id: ${id}`)
notes.push(`UI id: ${htmlIds.size} 个，双向一致`)

// ---------- 2. IPC 通道与载荷 ----------
const handlers = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]))
const invokes = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1])
for (const c of invokes) if (!handlers.has(c)) fail(`preload.js 调用了未注册的 IPC 通道: ${c}`)
for (const c of handlers) if (!invokes.includes(c)) fail(`主进程注册了但 preload.js 未暴露的通道: ${c}`)
const sends = new Set([...main.matchAll(/webContents\.send\('([^']+)'/g)].map((m) => m[1]))
const ons = new Set([...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]))
for (const c of sends) if (!ons.has(c)) fail(`主进程推送了但 preload.js 未监听的事件: ${c}`)
for (const c of ons) if (!sends.has(c)) fail(`preload.js 监听了但主进程未推送的事件: ${c}`)

// log-line 的载荷形状（最容易改坏：面板会把每行显示成 undefined）
const logSend = main.match(/webContents\.send\('log-line',\s*(\{[^}]*\})/)
if (!logSend) fail('主进程 log-line 的载荷不是对象字面量（面板按 {seq,text} 读取）')
else if (!/\bseq:/.test(logSend[1]) || !/\btext:/.test(logSend[1])) fail(`主进程 log-line 载荷缺少 seq/text: ${logSend[1]}`)
const logOn = preload.match(/ipcRenderer\.on\('log-line',\s*\(_e,\s*([A-Za-z0-9_$]+)\)\s*=>\s*cb\(([^)]*)\)/)
if (!logOn) fail('preload.js 的 log-line 监听形状异常（应为 (_e, item) => cb(item)）')
else if (logOn[1] !== logOn[2].trim()) fail(`preload.js 改写了 log-line 载荷（cb(${logOn[2].trim()})），面板会收到 undefined`)
if (!/\.text\b/.test(renderer) || !/\.seq\b/.test(renderer)) fail('renderer.js 未按 {seq,text} 读取日志载荷')
notes.push(`IPC: ${handlers.size} 个通道 / ${sends.size} 个事件，含 log-line 载荷形状`)

// ---------- 3. snapshot 与 env 字段 ----------
const snapBody = main.slice(main.indexOf('function snapshot()'), main.indexOf('function broadcast()'))
const snapKeys = [...snapBody.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1])
const readFields = [...new Set([...renderer.matchAll(/\bs\.([a-zA-Z]+)/g)].map((m) => m[1]))]
for (const f of readFields) if (!snapKeys.includes(f)) fail(`renderer.js 读取了 snapshot 未返回的字段: s.${f}`)
const envKeys = ['id', 'name', 'ready', 'version', 'detail', 'path']
const readEnv = [...new Set([...renderer.matchAll(/\bit\.([a-zA-Z]+)/g)].map((m) => m[1]))]
for (const f of readEnv) if (!envKeys.includes(f)) fail(`renderer.js 读取了 envItem 未提供的字段: it.${f}`)
notes.push(`契约: snapshot ${snapKeys.length} 个字段 / envItem ${envKeys.length} 个字段，渲染层取用全部存在`)

// ---------- 4. 打包文件清单 ----------
// 本项目只通过 NSIS 安装包分发（便携版已移除），清单以 package.json 的 build.files 为唯一来源，
// 并反向锁死：不得再出现便携组装脚本或非 nsis 目标。
const APP_FILES = ['main.js', 'preload.js', 'index.html', 'renderer.js', 'package.json', 'app.ico']
const fileList = pkg.build.files
if (JSON.stringify([...fileList].sort()) !== JSON.stringify([...APP_FILES].sort())) {
  fail(`package.json build.files 与约定的应用文件清单不一致\n    files: ${fileList.join(', ')}\n    约定: ${APP_FILES.join(', ')}`)
}
for (const f of fileList) if (!fs.existsSync(path.join(root, f))) fail(`打包清单中的文件不存在: ${f}`)
if (fs.existsSync(path.join(root, 'scripts', 'build.js'))) fail('又出现了便携版组装脚本 scripts/build.js（本项目只通过安装包分发）')
if (pkg.scripts && (pkg.scripts.build || pkg.scripts.portable)) fail('package.json 里又有 build/portable 脚本（本项目只通过安装包分发）')
const winTargets = (pkg.build.win && pkg.build.win.target) || []
for (const t of winTargets) if ((typeof t === 'string' ? t : t.target) !== 'nsis') fail(`electron-builder 里出现了非 nsis 目标: ${JSON.stringify(t)}（只发布安装包）`)
if (!winTargets.length) fail('electron-builder 没有配置 win.target（应为 nsis）')
// 构建完必须清掉 release\win-unpacked（那是可直接双击运行的程序副本）与 builder-debug.yml，
// 让 release\ 只剩安装包与自动更新元数据——本项目只通过安装包使用
const distScript = (pkg.scripts && pkg.scripts.dist) || ''
if (!/release\/win-unpacked/.test(distScript) || !/builder-debug\.yml/.test(distScript)) {
  fail('npm run dist 缺少构建后清理（应清掉 release/win-unpacked 与 builder-debug.yml，产物目录只留安装包）')
}
notes.push(`打包: ${fileList.length} 个文件与约定一致且都存在；分发方式仅 NSIS 安装包（构建后清掉解包副本）`)

// ---------- 5. 版本号 ----------
const lockRoot = lock.version
const lockPkg = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined
if (pkg.version !== lockRoot || pkg.version !== lockPkg) {
  fail(`版本号不一致: package.json=${pkg.version}, package-lock 顶层=${lockRoot}, packages[""]=${lockPkg}`)
}
const verMatch = readme.match(/应用版本：`([^`]+)`/)
if (!verMatch) {
  // 找不到标记就直接失败：否则这条校验会静默失效
  fail('README 中找不到「应用版本：`x.y.z`」标记，无法校验版本一致性（请保留该标记）')
} else if (verMatch[1] !== pkg.version) {
  fail(`README 应用版本(${verMatch[1]}) 与 package.json(${pkg.version}) 不一致`)
}
notes.push(`版本: ${pkg.version}（package.json 与 package-lock 一致，README 标记已校验）`)

// ---------- 6. 设置项与 README 文档 ----------
if (readme.indexOf('## 设置') < 0 || readme.indexOf('## 环境信息') < 0) {
  fail('README 缺少「## 设置」或「## 环境信息」小节，无法校验设置表')
} else {
  const defaults = main.slice(main.indexOf('const DEFAULT_SETTINGS'), main.indexOf('let settings ='))
  const settingKeys = [...defaults.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1])
  // 防止「正则失配 → 数组为空 → 循环不执行 → 静默通过」这种假绿
  if (settingKeys.length < 8) fail(`从 DEFAULT_SETTINGS 只解析出 ${settingKeys.length} 个设置项，正则很可能失配（本组检查会静默失效）`)
  const readmeSettings = readme.slice(readme.indexOf('## 设置'), readme.indexOf('## 环境信息'))
  for (const k of settingKeys) if (!readmeSettings.includes('`' + k + '`')) fail(`README 设置表缺少配置项: ${k}`)
  notes.push(`设置: ${settingKeys.length} 项，README 全部有说明`)
}

// ---------- 7. 状态徽章与样式 ----------
const states = new Set([...main.matchAll(/setStage\('([a-z]+)'/g)].map((m) => m[1]))
const badgeSrc = renderer.slice(renderer.indexOf('const BADGE_TEXT'), renderer.indexOf('// ---------- 节点式步骤条'))
const badgeKeys = new Set([...badgeSrc.matchAll(/([a-z]+):\s*'/g)].map((m) => m[1]))
for (const s of states) if (!badgeKeys.has(s)) fail(`状态 ${s} 在 renderer.js 的 BADGE_TEXT 中没有文案`)
// stopped 走基础 .badge 配色，其余状态都应有专属样式
const BASE_STATES = new Set(['stopped'])
const cssStates = new Set([...html.matchAll(/\.badge\.([a-z]+)/g)].map((m) => m[1]))
// 同样防止正则失配导致本组静默通过
if (states.size < 5) fail(`从 main.js 只解析出 ${states.size} 个状态（setStage 正则可能失配）`)
if (badgeKeys.size < 5) fail(`从 renderer.js 只解析出 ${badgeKeys.size} 个徽章文案（BADGE_TEXT 正则可能失配）`)
for (const s of badgeKeys) if (!BASE_STATES.has(s) && !cssStates.has(s)) fail(`index.html 缺少 .badge.${s} 样式（徽章会没有配色）`)
for (const s of cssStates) if (!badgeKeys.has(s)) fail(`index.html 里的 .badge.${s} 没有对应的状态文案`)
notes.push(`状态: 主进程置位 ${states.size} 种，徽章文案与 CSS 样式全部覆盖`)

// ---------- 7b. 安装器脚本与主进程之间的契约 ----------
// 这几条以前没人查，但任何一条漂移都会造成真实后果（升级漏搬数据 / 警告文件变乱码 / 静默升级卡死）
const nsh = read(path.join('scripts', 'installer-extra.nsh'))
// (a) 升级要搬移/还原的数据目录必须与主进程实际写在程序根下的目录完全一致
//     （来源从便携组装脚本改为 main.js：安装器与主进程是两个独立文件，任何一边加了目录
//      而另一边没跟上，升级就会漏搬 / 漏还原数据）
const keepDirs = [...new Set([...main.matchAll(/path\.join\(rootDir, '([a-zA-Z]+)'\)/g)].map((m) => m[1]))].sort()
const movedDirs = [...new Set([...nsh.matchAll(/launcherMoveData\s+([a-z]+)/g)].map((m) => m[1]))].sort()
const restoredDirs = [...new Set([...nsh.matchAll(/launcherRestoreData\s+([a-z]+)/g)].map((m) => m[1]))].sort()
if (keepDirs.length === 0 || movedDirs.length === 0) fail('无法解析 main.js 的程序根目录或安装器的数据目录列表（契约检查失效）')
else {
  if (JSON.stringify(keepDirs) !== JSON.stringify(movedDirs)) fail(`安装器搬移的目录与 main.js 程序根目录不一致\n    main.js: ${keepDirs.join(', ')}\n    安装器搬移: ${movedDirs.join(', ')}`)
  if (JSON.stringify(keepDirs) !== JSON.stringify(restoredDirs)) fail(`安装器还原的目录与 main.js 程序根目录不一致\n    main.js: ${keepDirs.join(', ')}\n    安装器还原: ${restoredDirs.join(', ')}`)
}
// (b) 警告文件必须用 UTF-16LE 写、首行必须是纯 ASCII 产品名，且 main.js 能识别这种无 BOM 的 UTF-16LE
if (!/FileWriteUTF16LE\s+\$R8\s+"DeepSeekHarnessLauncher\$\\r\$\\n"/.test(nsh)) {
  fail('安装器写警告文件的首行不是 FileWriteUTF16LE + 纯 ASCII 产品名（主进程的编码探测会失效）')
}
if (!/buf\[1\] === 0 && buf\[3\] === 0/.test(main)) fail('main.js 的 decodeTextFile 缺少「无 BOM UTF-16LE」识别分支')
// (c) 静默执行路径上不能有缺 /SD 的 MessageBox：NSIS 会弹框并永久阻塞（升级看起来卡死）
const bareMsgs = nsh.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /^\s*MessageBox/.test(l) && !/\/SD/.test(l))
if (bareMsgs.length) fail(`安装器里有 ${bareMsgs.length} 处 MessageBox 缺 /SD（静默执行会弹框并永久阻塞）: 行 ${bareMsgs.map(([n]) => n).join(', ')}`)
// (d) 升级分支必须静默：customUnInstall 的 ${if} ${isUpdated} 分支里不得出现弹窗
//     （普通卸载的确认框属于正常交互，保留）
const unStart = nsh.indexOf('!macro customUnInstall')
const unEnd = nsh.search(/\n!macro customInstall\r?\n/)
if (unStart < 0 || unEnd <= 0) fail('找不到 customUnInstall/customInstall 的边界，无法校验升级路径是否静默')
else {
  const unBody = nsh.slice(unStart, unEnd)
  const elseIdx = unBody.search(/\$\{else\}/)
  const upgradeBranch = elseIdx > 0 ? unBody.slice(0, elseIdx) : unBody
  if (/^\s*MessageBox/m.test(upgradeBranch)) fail('升级分支里出现了弹窗，升级会打断用户（应只写 UPGRADE-DATA-WARNING.txt）')
}
// (e) 中止必须真正生效：SetErrorLevel 要在 Abort 之前
if (!/SetErrorLevel 1[\s\S]{0,120}?Abort/.test(nsh)) fail('安装器中止前没有 SetErrorLevel 1（Abort 不影响退出码，安装器会当成成功继续装）')
// (f) 安装明细窗口保持 electron-builder 默认（不显示）
//     实测（同套 makensis + nsis7z 插件探针）：这个打包方式下明细里只有 app-64.7z 那一条
//     File 的 "Extract:" 行，插件（Nsis7z）一行不打、CopyFiles 只打一条 "Copy to:"，
//     逐文件信息不接管模板就拿不到。所以反向锁死：不得再打开明细窗口。
if (/ShowInstDetails|ShowUninstDetails|SetDetailsPrint/.test(nsh.replace(/^\s*;.*$/gm, ''))) fail('installer-extra.nsh 又出现了 ShowInstDetails/ShowUninstDetails/SetDetailsPrint（明细窗口应保持模板默认的隐藏）')
notes.push(`安装器契约: 数据目录 ${keepDirs.length} 个与 main.js 程序根目录一致，警告文件编码/首行、/SD、静默升级、中止语义均已校验；明细窗口保持模板默认（不显示）`)

// ---------- 7c. 工作流 YAML ----------
// 教训：release.yml 里曾经把一段 node -e 脚本直接写成未加引号的 run: 值，脚本里的
// "标签与版本一致: " 含「冒号+空格」，在 YAML 里是映射分隔符 → 整个工作流被判
// "Invalid workflow file"（GitHub 报第 33 行）。此前自检只看 JS 与安装器，没人解析 YAML，
// 所以这个错误一直潜伏到打 tag 才暴露。这里补上：所有工作流必须能被 YAML 解析。
const wfDir = path.join(root, '.github', 'workflows')
const wfFiles = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/i.test(f)) : []
let yamlLib = null
try { yamlLib = require('js-yaml') } catch (e) { /* 下面统一报错 */ }
if (!yamlLib) fail('缺少 js-yaml，无法校验工作流 YAML（electron-builder 的依赖链应提供它）')
else if (wfFiles.length === 0) fail('.github/workflows 下没有工作流文件')
else {
  let wfErrors = 0
  for (const f of wfFiles) {
    const text = fs.readFileSync(path.join(wfDir, f), 'utf8')
    try {
      yamlLib.load(text)
    } catch (e) {
      wfErrors++
      const line = e && e.mark && typeof e.mark.line === 'number' ? e.mark.line + 1 : '?'
      fail(`工作流 ${f} 的 YAML 语法错误（第 ${line} 行）: ${String((e && (e.reason || e.message)) || e).split('\n')[0]}`)
    }
  }
  const relPath = path.join(wfDir, 'release.yml')
  if (wfErrors === 0 && fs.existsSync(relPath)) {
    let doc = null
    try { doc = yamlLib.load(fs.readFileSync(relPath, 'utf8')) } catch (e) { /* 上面已报 */ }
    const steps = (doc && doc.jobs && doc.jobs.build && doc.jobs.build.steps) || []
    const runs = steps.map((s) => String((s && s.run) || '')).join('\n')
    if (steps.length === 0) fail('release.yml 里找不到 build 作业的步骤（契约检查失效）')
    if (!/GITHUB_REF_NAME|check-tag/.test(runs)) fail('release.yml 缺少「标签与 package.json 版本一致」校验步骤')
    if (!/npm run dist/.test(runs)) fail('release.yml 缺少 npm run dist 构建步骤')
    if (!/action-gh-release/.test(JSON.stringify(steps))) fail('release.yml 缺少发布到 GitHub Release 的步骤')
    notes.push(`工作流: ${wfFiles.length} 个 YAML 解析通过；release.yml 含标签校验 / 构建 / 发布三步`)
  }
}

// ---------- 8. 语法 ----------
const jsFiles = ['main.js', 'preload.js', 'renderer.js', 'scripts/check.js', 'scripts/check-tag.js', 'scripts/clean.js']
for (const f of jsFiles) {
  try {
    new vm.Script(read(f), { filename: f }) // 只编译不执行
  } catch (e) {
    fail(`语法错误 ${f}: ${e.message}`)
  }
}
notes.push(`语法: ${jsFiles.length} 个 JS 文件编译通过`)

// ---------- 输出 ----------
for (const n of notes) console.log('  ok   ' + n)
if (problems.length > 0) {
  console.error('\n发现 ' + problems.length + ' 个问题：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('\n一致性自检通过。')
