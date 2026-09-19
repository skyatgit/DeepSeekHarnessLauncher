// DeepSeekHarnessLauncher —— 主进程（流程完全内置，不依赖任何外部脚本）
// 完整流程：下载便携 Node.js / Git → GitHub 拉取源码 → pnpm 装依赖 → 构建 → 启动 dsh
// 另含：自动更新、端口自动避让、停止、托盘、主面板、开机自启
const { app, Tray, Menu, nativeImage, dialog, shell, BrowserWindow, ipcMain, screen } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')
const net = require('net')
const os = require('os')
const zlib = require('zlib')

// ==================== 路径 ====================
const appDir = __dirname
// 部署态（安装版）：<安装目录>\resources\app → 程序根 = 安装目录
// 开发态（npm run start，从源码运行）：<项目> 根 → 程序根 = 项目根
const deployedRoot = path.resolve(appDir, '..', '..')
const isDeployed = fs.existsSync(path.join(deployedRoot, 'resources', 'app', 'main.js'))
const rootDir = isDeployed ? deployedRoot : appDir
// Chromium 用户数据固定放用户级目录：单例锁在 Windows 上按 userData 划作用域，
// 安装版与开发版只有共享 userData 才能全局互斥，无论从哪个位置运行都只允许一个实例
try { app.setPath('userData', path.join(app.getPath('appData'), 'DeepSeekHarnessLauncher', 'user-data')) } catch (e) { /* 忽略 */ }
const configDir = path.join(rootDir, 'config')
const settingsPath = path.join(configDir, 'settings.json')
const runtimeDir = path.join(rootDir, 'runtime')
const nodeDir = path.join(runtimeDir, 'node')
const nodeExe = path.join(nodeDir, 'node.exe')
const gitDir = path.join(runtimeDir, 'git')
const gitExe = path.join(gitDir, 'cmd', 'git.exe')
const pnpmDir = path.join(runtimeDir, 'pnpm')
const pnpmJs = path.join(pnpmDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
const pnpmStoreDir = path.join(runtimeDir, 'pnpm-store')
const homeDir = path.join(runtimeDir, 'home')
const cacheDir = path.join(rootDir, 'cache')
const logDir = path.join(rootDir, 'logs')
const uiLogPath = path.join(logDir, 'launcher.log')
const dataDir = path.join(rootDir, 'data')
const sourceParent = path.join(rootDir, 'source')
const sourceDir = path.join(sourceParent, 'deepseek-harness')
// 构建产物入口：apps/cli/lib/bin.js 是 apps/cli 发布到 npm 时使用的正式入口（package.json 的 bin 字段），
// 不需要 tsx 现场转译，启动更快且不依赖 node_modules 中的 tsx
const cliBuiltEntry = path.join(sourceDir, 'apps', 'cli', 'lib', 'bin.js')
const appIcoPath = path.join(appDir, 'app.ico')
const LOG_BUFFER_MAX = 1200
// 日志文件上限：超过即轮转为 launcher.log.1，避免长期使用无限增长
const LOG_MAX_BYTES = 5 * 1024 * 1024
// 保留的轮转备份份数（launcher.log.1 / .2）：多留一份，服务地址与 token 才不会
// 在第二次轮转后彻底丢失（token 地址是「打开 Web UI」唯一可用的入口）
const LOG_BACKUPS = 2
// 启动时回读日志的最大字节数：只读尾部，不把整个日志读进内存
const LOG_TAIL_BYTES = 256 * 1024
// 等待 dsh 打印服务地址的上限：首次启动要加载整个插件树，实测出现过 13 秒，
// 原来的 15 秒会让正常启动被误判为超时（日志里已实际发生过两次）
const START_TIMEOUT_MS = 60000
// git ls-remote 超时（异步执行，不阻塞主进程）
const GIT_LS_REMOTE_TIMEOUT_MS = 60000

// ==================== 设置 ====================
const DEFAULT_SETTINGS = {
  nodeVersion: '22.23.2',
  nodeBase: 'https://nodejs.org/dist',
  pnpmVersion: '11.7.0',
  mingitUrl: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip',
  repoUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
  branch: 'master',
  npmRegistry: 'https://registry.npmjs.org/',
  host: '127.0.0.1',
  port: 3080,
  updateCheck: 'auto',
  openBrowser: true,
  autoStartDsh: false
}
let settings = Object.assign({}, DEFAULT_SETTINGS)

// settings.json 是用户可手改的：合并前逐项校验类型与取值，
// 否则 "port": "3080" 这类写法会让端口探测、+50 推算等逻辑静默走偏
function clampPort(v, def) {
  const n = typeof v === 'number' ? v : parseInt(String(v == null ? '' : v).trim(), 10)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : def
}

// host 必须是可监听的主机名/IP，不能是 URL 或带端口的写法——
// 否则每次 listen 都会失败，端口扫描会一路扫到上限并报「端口全部被占用」
function validHost(h) {
  if (h === '*' || h === 'localhost') return true
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return h.split('.').every((n) => Number(n) <= 255)
  if (h.indexOf(':') >= 0) return /^[0-9a-fA-F:]+$/.test(h) // IPv6
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(h)
}

function sanitizeSettings(saved) {
  const s = Object.assign({}, DEFAULT_SETTINGS)
  if (!saved || typeof saved !== 'object') return s
  const str = (v, def) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : def)
  const bool = (v, def) => (typeof v === 'boolean' ? v : def)
  s.nodeVersion = str(saved.nodeVersion, s.nodeVersion)
  s.nodeBase = str(saved.nodeBase, s.nodeBase).replace(/\/+$/, '')
  s.pnpmVersion = str(saved.pnpmVersion, s.pnpmVersion)
  s.mingitUrl = str(saved.mingitUrl, s.mingitUrl)
  s.repoUrl = str(saved.repoUrl, s.repoUrl)
  s.branch = str(saved.branch, s.branch)
  s.npmRegistry = str(saved.npmRegistry, s.npmRegistry)
  const host = str(saved.host, s.host)
  s.host = validHost(host) ? host : DEFAULT_SETTINGS.host
  s.port = clampPort(saved.port, s.port)
  s.updateCheck = saved.updateCheck === 'off' ? 'off' : 'auto'
  s.openBrowser = bool(saved.openBrowser, s.openBrowser)
  s.autoStartDsh = bool(saved.autoStartDsh, s.autoStartDsh)
  return s
}
function loadSettings() {
  try {
    settings = sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')))
  } catch (e) {
    settings = Object.assign({}, DEFAULT_SETTINGS) // 首次运行或文件损坏
  }
}
loadSettings()
function saveSettings() {
  try {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
  } catch (e) { /* 忽略 */ }
}
function ensureDefaultSettings() {
  if (!fs.existsSync(settingsPath)) saveSettings()
}

// ==================== 运行状态 ====================
let state = 'stopped' // stopped|provision|fetch|install|build|starting|running|stopping|updating|error
let detail = ''
let uiUrl = ''
let tokenUrl = ''
let lastActivity = ''
let lastError = ''
let child = null
let busy = false
let activeProc = null
let tray = null
let win = null
let quitting = false
let exiting = false // 退出流程已开始（含异步确认阶段），用于防重入并抑制退出期的状态噪声
let stopBusy = false // 停止流程进行中，防止重复触发
let envCache = null
let envComputing = false
let taskStep = -1 // 步骤条：当前执行到的任务步骤下标；-1 表示无进行中任务
const logBuffer = []
let logSeq = 0 // 日志行序号：面板据此去重（快照回放与实时推送会重叠）

// 启动/更新流程的任务步骤（面板节点式步骤条）
const TASK_STEPS = ['准备环境', '拉取源码', '安装依赖', '构建项目', '启动服务']

function setStage(s, d) {
  state = s
  if (d !== undefined) detail = d
  // 跟踪步骤条：任务阶段推进到对应节点；error/stopping 保持当前节点（面板标红/显示）；stopped 清空
  switch (s) {
    case 'provision': case 'updating': taskStep = 0; break
    case 'fetch': taskStep = 1; break
    case 'install': taskStep = 2; break
    case 'build': taskStep = 3; break
    case 'starting': taskStep = 4; break
    case 'running': taskStep = TASK_STEPS.length; break
    case 'stopped': taskStep = -1; break
    default: break
  }
  rebuildMenu()
  broadcast()
}

let logBytes = -1 // 已知的日志文件大小；-1 表示尚未统计

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// 日志轮转：超过 LOG_MAX_BYTES 时把 launcher.log 改名为 launcher.log.1（备份依次后移 .1→.2），
// 避免每轮构建刷几千行、长期使用后日志膨胀到几十上百 MB
function rotateLogIfNeeded() {
  if (logBytes < 0) {
    try { logBytes = fs.statSync(uiLogPath).size } catch (e) { logBytes = 0 }
  }
  if (logBytes < LOG_MAX_BYTES) return
  const old = uiLogPath + '.1'
  try {
    // 备份依次后移（.1 → .2 → 丢弃），最后把当前日志改名为 .1
    fs.rmSync(uiLogPath + '.' + LOG_BACKUPS, { force: true })
    for (let i = LOG_BACKUPS - 1; i >= 1; i--) {
      const from = uiLogPath + '.' + i
      if (fs.existsSync(from)) fs.renameSync(from, uiLogPath + '.' + (i + 1))
    }
    fs.renameSync(uiLogPath, old)
    const notice = stamp() + '  日志已达 ' + fmtMb(LOG_MAX_BYTES) + '，已轮转为 ' + path.basename(old) + '\r\n'
    fs.appendFileSync(uiLogPath, notice, 'utf8')
    logBytes = Buffer.byteLength(notice)
  } catch (e) {
    // 轮转失败（例如日志被独占打开）不能连累正常写日志；计数清零，避免每行都重试
    logBytes = 0
  }
}

function log(line) {
  const text = String(line)
  if (!text) return
  lastActivity = text
  try {
    fs.mkdirSync(logDir, { recursive: true })
    rotateLogIfNeeded()
    const row = stamp() + '  ' + text + '\r\n'
    fs.appendFileSync(uiLogPath, row, 'utf8')
    logBytes += Buffer.byteLength(row)
  } catch (e) { /* 忽略 */ }
  logBuffer.push(text)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
  logSeq++
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('log-line', { seq: logSeq, text: text }) } catch (e) { /* 忽略 */ }
  }
}

// 只读日志尾部若干字节（当前日志或轮转后的 launcher.log.1）：
// 启动时回读上次会话的地址，避免把整个日志读进内存
function readLogTail(file, maxBytes) {
  try {
    const size = fs.statSync(file).size
    let start = Math.max(0, size - maxBytes)
    const truncated = start > 0
    if (truncated) start -= 1 // 多读一个字节，用于判断窗口边界是否恰好落在行首
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.allocUnsafe(len)
    const fd = fs.openSync(file, 'r')
    let read = 0
    try { read = fs.readSync(fd, buf, 0, len, start) } finally { fs.closeSync(fd) }
    // 必须按实际读到的字节数截断：文件在 stat 与 read 之间变小的话，尾部会是未初始化内存
    let head = buf.slice(0, read)
    if (truncated && head.length > 0) {
      if (head[0] === 0x0a) {
        head = head.slice(1) // 边界正好压在换行后，窗口第一行是完整的
      } else {
        const nl = head.indexOf(0x0a) // 否则首行被截断，丢掉它
        head = nl < 0 ? Buffer.alloc(0) : head.slice(nl + 1)
      }
    }
    return head.toString('utf8')
  } catch (e) { return '' }
}

function notify(title, body) {
  // 不发系统通知，只记录到主面板日志
  log(title + '：' + shorten(body, 200))
}

function shorten(s, max) {
  s = String(s == null ? '' : s)
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

// ==================== 单实例 ====================
// 全局互斥：Electron 的单实例锁在 Windows 上按 userData 目录划作用域（见文件头 app.setPath('userData', ...)），
// 各版本共享同一 userData 因此天然全局互斥。requestSingleInstanceLock 的参数是传给首实例的
// additionalData，不是锁名，这里无需传值。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.setAppUserModelId('com.deepseekharness.launcher')
  app.whenReady().then(init)
}

function init() {
  // 程序目录不可写时（例如装到受保护目录但没有写入权限）必须给出明确提示，
  // 否则窗口和托盘都建不出来，进程直接静默退出，用户看不到任何信息
  try {
    ensureDefaultSettings()
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (e) {
    dialog.showErrorBox('DeepSeekHarnessLauncher 无法启动',
      '程序目录不可写：\n' + rootDir + '\n\n' + String((e && e.message) || e) +
      '\n\n请改用有写入权限的位置安装（例如用户目录），或以管理员身份运行。')
    quitting = true
    app.quit()
    return
  }
  try {
    createWindow()
    tray = makeTray()
    rebuildMenu()
  } catch (e) {
    log('创建窗口/托盘失败: ' + String((e && e.message) || e))
    try {
      dialog.showErrorBox('DeepSeekHarnessLauncher 托盘创建失败',
        String((e && e.message) || e) + '\n\n主面板仍可使用（启动 / 停止 / 退出），但关闭窗口后将无法从托盘唤回。')
    } catch (e2) { /* 忽略 */ }
  }
  detectExternal().catch(() => {})
  collectEnv().catch(() => {})
  reportUpgradeWarning()
  if (settings.autoStartDsh && state === 'stopped' && !child && !detectExternalPid()) startFlow()
}

// 上次升级若出现数据迁移问题，安装器会写一份说明文件（静默卸载时弹窗看不到）；
// 启动时把它显示到主面板日志里，避免这类警告被永久埋没
function reportUpgradeWarning() {
  try {
    const f = path.join(rootDir, 'UPGRADE-DATA-WARNING.txt')
    if (!fs.existsSync(f)) return
    const text = decodeTextFile(fs.readFileSync(f)).trim().replace(/\s*\r?\n\s*/g, ' ')
    log('注意：上次升级存在数据迁移警告，详见 ' + f + ' —— ' + text)
    lastError = '上次升级存在数据迁移警告，详见 ' + f
  } catch (e) { /* 忽略 */ }
}

// 安装器写的警告文件不是 UTF-8：1.0.4 起用 NSIS 的 FileWriteUTF16LE（无 BOM 的 UTF-16LE，
// 首行是 ASCII 文件名便于识别），更早的版本用 FileWrite（系统 ANSI 代码页，本机为 CP936）。
// 直接按 UTF-8 读会把中文变成一堆替换字符，等于这条唯一的升级警告白写。这里按特征逐级探测
function decodeTextFile(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le', 2)
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf8', 3)
  // 无 BOM 的 UTF-16LE：首行是纯 ASCII，奇数字节全为 0
  if (buf.length >= 8 && buf[1] === 0 && buf[3] === 0 && buf[5] === 0 && buf[7] === 0) return buf.toString('utf16le')
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try { return new TextDecoder('gbk').decode(buf) } catch (e) { return utf8 }
}

// ==================== 主窗口 ====================
function createWindow() {
  // 高度自适应屏幕可用区域，保证全部内容（状态/环境列表/日志）完整可见
  let wa = { width: 1920, height: 1040 }
  try { wa = screen.getPrimaryDisplay().workAreaSize } catch (e) { /* 忽略 */ }
  const winWidth = Math.max(660, Math.min(wa.width - 160, 720))
  // 高度必须落在可用区域内（面板本身可滚动，不再依赖固定高度）
  const winHeight = Math.min(Math.max(wa.height - 40, 560), 1000)
  win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 520,
    minHeight: 560,
    title: 'DeepSeekHarnessLauncher',
    icon: appIcoPath,
    autoHideMenuBar: true,
    backgroundColor: '#0f1420',
    webPreferences: {
      preload: path.join(appDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.loadFile(path.join(appDir, 'index.html'))
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => { win = null })
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ==================== 托盘 ====================
function makeTray() {
  let icon = nativeImage.createEmpty()
  try {
    const base = nativeImage.createFromPath(appIcoPath)
    if (!base.isEmpty()) {
      // 托盘图标必须是非空真实图像（唯一图标源 app.ico 缩放到 16px）；空图像会导致图标不显示
      const small = base.resize({ width: 16, height: 16 })
      if (!small.isEmpty()) icon = small
    }
  } catch (e) { /* 忽略 */ }
  const t = new Tray(icon)
  t.on('click', () => showWindow())
  t.on('double-click', () => showWindow())
  return t
}

function rebuildMenu() {
  if (!tray) return
  try {
    const status = statusText()
    const idle = state === 'stopped' || state === 'error'
    const menu = Menu.buildFromTemplate([
    { label: '显示主面板', click: () => showWindow() },
    { label: '状态: ' + status, enabled: false },
    { type: 'separator' },
    { label: '打开 Web UI', enabled: !!(tokenUrl || uiUrl), click: () => openWeb() },
    { label: '启动 DeepSeek Harness', enabled: idle && !detectExternalPid(), click: () => startFlow() },
    { label: '停止', enabled: state === 'running' || state === 'starting' || !!detectExternalPid(), click: () => stopDsh() },
    { label: '检查并更新', enabled: idle && !detectExternalPid(), click: () => updateFlow() },
    { type: 'separator' },
    { label: '查看日志', click: () => openLogs() },
    { label: '打开程序文件夹', click: () => { try { shell.openPath(rootDir) } catch (e) {} } },
    { type: 'separator' },
    { label: '启动器启动时自动运行 dsh', type: 'checkbox', checked: !!settings.autoStartDsh, click: (item) => { settings.autoStartDsh = item.checked; saveSettings(); broadcast() } },
    { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => { setOpenAtLogin(item.checked); broadcast() } },
    { type: 'separator' },
    { label: '退出', click: () => exitApp() }
  ])
    tray.setContextMenu(menu)
    tray.setToolTip('DeepSeekHarnessLauncher - ' + status)
  } catch (e) { /* 托盘可能已销毁，忽略 */ }
}

// ==================== IPC ====================
ipcMain.handle('get-snapshot', () => snapshot())
ipcMain.handle('start', () => { startFlow(); return true })
ipcMain.handle('stop', () => { stopDsh(); return true })
ipcMain.handle('update', () => { updateFlow(); return true })
ipcMain.handle('open-web', () => { openWeb(); return true })
ipcMain.handle('open-logs', () => { openLogs(); return true })
ipcMain.handle('open-folder', () => { openFolder(); return true })
ipcMain.handle('set-auto-start-dsh', (_e, v) => { settings.autoStartDsh = !!v; saveSettings(); broadcast(); return true })
ipcMain.handle('set-open-at-login', (_e, v) => { setOpenAtLogin(!!v); broadcast(); return true })
ipcMain.handle('exit-app', () => { exitApp(); return true })
ipcMain.handle('get-env', () => collectEnv())
ipcMain.handle('open-path', (_e, p) => { openPath(p); return true })

function snapshot() {
  const idle = state === 'stopped' || state === 'error'
  const recorded = !!detectExternalPid() // 有存活记录时启动/停止的口径必须与托盘一致
  return {
    state: state,
    statusText: statusText(),
    detail: detail,
    uiUrl: uiUrl,
    tokenUrl: tokenUrl,
    lastActivity: lastActivity,
    lastError: lastError,
    steps: TASK_STEPS,
    stepIndex: taskStep,
    stepFailed: state === 'error',
    // 面板按钮的可用性由主进程给出：托盘菜单用的是同一套判定，
    // 否则会出现「面板启动可点但必然失败、停止却被禁用」这类不一致
    canStart: idle && !child && !busy && !recorded,
    canStop: state === 'running' || state === 'starting' || state === 'stopping' || recorded,
    canUpdate: idle && !child && !busy && !recorded,
    autoStartDsh: !!settings.autoStartDsh,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    logSeq: logSeq,
    logLines: logBuffer.slice(-500)
  }
}

function broadcast() {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('state', snapshot()) } catch (e) { /* 忽略 */ }
  }
}

function statusText() {
  switch (state) {
    case 'provision': return '准备环境'
    case 'fetch': return '拉取源码'
    case 'install': return '安装依赖'
    case 'build': return '构建中'
    case 'starting': return '启动中'
    case 'running': return (child ? '' : '（外部）') + '运行中' + (uiUrl ? ' http://' + uiUrl : '')
    case 'stopping': return '停止中'
    case 'updating': return '更新中'
    case 'error': return '出错'
    default: return '已停止'
  }
}

// 环境是否已完整预装（全部就绪 = 无需任何准备，直接启动）
async function isEnvReady() {
  try {
    if (!fs.existsSync(nodeExe) || !fs.existsSync(gitExe) || !fs.existsSync(pnpmJs)) return false
    if (!fs.existsSync(path.join(sourceDir, 'package.json'))) return false
    if (!fs.existsSync(path.join(sourceDir, 'node_modules', '.modules.yaml'))) return false
    if (!fs.existsSync(cliBuiltEntry)) return false
    return await builtMatches()
  } catch (e) { return false }
}

// ==================== 完整启动流程 ====================
async function startFlow() {
  if (busy || child) { log('已有任务正在进行，忽略本次启动请求'); return }
  // 重新读取 settings.json：改过 host/port/版本等设置后无需重启启动器，再点一次即可生效
  // （否则「host 填错 → 启动必然失败」的提示会让按钮变成一个无法兑现的承诺）
  loadSettings()
  busy = true // 先占位：后面的端口确认是异步的，期间不能再受理第二次启动
  lastError = ''
  try {
    if (detectExternalPid()) {
      // 有记录还不够：系统会复用 PID，先确认记录里的端口真的有服务在听
      const rec = readDshPidInfo()
      const fromLog = rec && !(rec.port && rec.host) ? hostPortFromLog() : { host: '', port: 0 }
      const port = (rec && rec.port) || fromLog.port || 0
      const probe = (port && rec) ? await probeRecordedService(rec, port) : { status: 'serving', hosts: [] }
      if (probe.status === 'serving') { setStage('running'); return }
      if (probe.status === 'unknown') {
        // 记录里的地址不可用，探测不出结论：按「仍在运行」处理并说明如何解除，
        // 但不能抛错卡住启动（那会让用户只能手删 runtime\dsh.pid）
        log('无法在 ' + probe.hosts.join(' / ') + ' 探测端口 ' + port + '（地址本机不可监听）；' +
          '若确认该 dsh 已不需要，请先在托盘或面板点「停止」，或结束进程后删除 runtime\\dsh.pid')
        setStage('running')
        return
      }
      log('PID 记录中的进程未在端口 ' + port + ' 提供服务，按残留记录清理，继续启动')
      clearDshPid()
    }
    if (await isEnvReady()) {
      log('环境已就绪（已预装），直接启动')
    } else {
      setStage('provision', '准备环境（首次运行需下载，约 10~30 分钟）...')
      await ensureNode()
      await ensureGit()
      setStage('provision', '检查 pnpm ...')
      await ensurePnpm()
      setStage('fetch', '拉取源码 ...')
    }
    const src = await ensureSource()
    const updated = src.updated

    if (updated || !fs.existsSync(path.join(sourceDir, 'node_modules', '.modules.yaml'))) {
      setStage('install', '安装依赖（pnpm）...')
      await installDeps()
    } else {
      log('依赖已就绪，跳过安装')
    }

    if (updated || !(await builtMatches()) || !fs.existsSync(cliBuiltEntry)) {
      setStage('build', '构建项目 ...')
      await buildProject()
    } else {
      log('构建已就绪，跳过构建')
    }

    setStage('starting', '启动服务 ...')
    await startServer()
  } catch (err) {
    const msg = String((err && err.message) || err)
    lastError = msg
    log('错误: ' + msg)
    setStage('error', '出错：' + msg)
    notify('启动失败', msg)
  } finally {
    busy = false
    // busy 参与 canStart/canUpdate 的计算，而最后一次 setStage 是在 busy 复位之前广播的：
    // 这里必须再推一次快照，否则流程结束后面板的启动/更新按钮会一直停在禁用态
    broadcast()
    collectEnv().catch(() => {})
  }
}

async function updateFlow() {
  if (busy || child) { log('已有任务正在进行，忽略本次更新请求'); return }
  loadSettings() // 与 startFlow 一致：改过设置后无需重启启动器
  busy = true
  lastError = ''
  try {
    setStage('updating', '检查更新 ...')
    await ensureNode()
    await ensureGit()
    await ensurePnpm()
    const src = await ensureSource(true)
    if (!src.updated) {
      if (src.offline) {
        // 离线时拿不到 remoteSha，无法区分「已是最新」与「没能检查」，必须如实告知
        log('无法连接 GitHub，未能检查更新（离线运行）')
        notify('未能检查更新', '网络不可达，继续使用本地版本')
      } else {
        log('已是最新版本，无需更新')
        notify('已是最新版本', '无需更新')
      }
      setStage('stopped')
      return
    }
    setStage('install', '更新依赖 ...')
    await installDeps()
    setStage('build', '重新构建 ...')
    await buildProject()
    notify('更新完成', '已更新到最新版本')
    setStage('stopped')
  } catch (err) {
    const msg = String((err && err.message) || err)
    lastError = msg
    log('更新失败: ' + msg)
    setStage('error', '更新失败：' + msg)
    notify('更新失败', msg)
  } finally {
    busy = false
    broadcast() // 同 startFlow：busy 复位后必须再推一次，否则面板按钮停在禁用态
    collectEnv().catch(() => {})
  }
}

// ==================== 环境准备 ====================
// 文件是否正被别的进程使用：Windows 上以「可写」方式打开正在运行的映像（exe）会被拒绝。
// 只读打开是允许的，所以必须带写权限才能测出来
function fileInUse(p) {
  try {
    const fd = fs.openSync(p, 'r+')
    fs.closeSync(fd)
    return false
  } catch (e) {
    if (!e) return false
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false
    return true
  }
}

// 等文件不再被占用：占用者未必是 dsh——启动器自身的环境探测（collectEnv 会跑 node -v 与
// node <pnpm.cjs> --version）也可能持有它，冷启动实测可达约 2 秒；另一个启动器实例在安装依赖/
// 构建时同样会持有。所以预算给到 4 秒，只有持续占用才判定为「真的有人在用」。
// 真正的 dsh 占用是持续的，4 秒后仍被占用就如实报错
async function waitFileFree(p, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 4000)
  for (;;) {
    if (!fileInUse(p)) return true
    if (Date.now() >= deadline) return false
    await sleep(200)
  }
}

// 目录替换：先把现役目录改名让位，换上新的之后再删旧的；中途失败就回滚。
// 这样「要么旧环境完好，要么新环境就位」，不会出现两头落空。
// 特别注意旧运行时可能正被**后台运行的 dsh** 占用（Windows 允许改名，却删不掉正在运行的 exe），
// 那样会留下「新运行时已就位、.version 还写着旧版本、旧进程仍在跑」的错乱状态。
// 所以在动手之前先探测占用，确认被占用就直接报错、什么都不动
async function swapDir(src, dest, label, probeRel) {
  const name = label || '运行时'
  const old = dest + '.old'
  if (probeRel) {
    const probe = path.join(dest, probeRel)
    if (!(await waitFileFree(probe))) {
      throw new Error(name + '正被占用（' + probe + '）：可能是后台运行的 dsh，也可能是另一个启动器实例' +
        '或启动器自身的环境探测。本次未替换，请稍后重试；若确实有 dsh 在运行，请先停止 dsh')
    }
  }
  // 上一次替换留下的旧目录：清掉，清不掉通常是它仍被占用
  try { fs.rmSync(old, { recursive: true, force: true }) } catch (e) { /* 下面按存在性判断给出明确错误 */ }
  if (fs.existsSync(old)) {
    throw new Error('上一次替换留下的 ' + old + ' 无法删除（通常仍被 dsh 占用），本次未替换：请先停止 dsh 后重试')
  }
  const had = fs.existsSync(dest)
  if (had) fs.renameSync(dest, old)
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    if (had && !fs.existsSync(dest)) {
      try { fs.renameSync(old, dest) } catch (e2) { /* 回滚也失败：旧目录仍在 <dest>.old，不会丢 */ }
    }
    throw e
  }
  // 新目录已就位；删旧目录属于收尾工作
  try { fs.rmSync(old, { recursive: true, force: true }) } catch (e) { /* 见下 */ }
  if (fs.existsSync(old)) {
    // 极少见：刚换上就又被别的进程打开。此时不再回滚（旧目录可能已被部分删除），
    // 但如实记录，并交给每次启动时的清理逻辑（ensureNode/ensurePnpm 开头会尝试删除 .old）
    log('注意：旧' + name + '目录暂时无法删除，已保留为 ' + old + '，下次启动时会再次尝试清理')
  }
}

async function ensureNode() {
  const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  const want = settings.nodeVersion + '-' + arch
  const marker = path.join(nodeDir, '.version')
  // 上一次替换可能留下 node.old（当时被占用删不掉）：每次启动都尽力清一次，
  // 否则那几百 MB 会一直占着，直到下一次真正发生版本替换。
  // 但只在现役运行时完好时才清：万一替换过程中两个 rename 都失败，.old 就是唯一可用的运行时
  if (fs.existsSync(nodeExe)) {
    try { fs.rmSync(nodeDir + '.old', { recursive: true, force: true }) } catch (e) { /* 仍被占用，下次再试 */ }
  }
  if (fs.existsSync(nodeExe) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === want) return
  log('准备便携版 Node.js v' + settings.nodeVersion + '（' + arch + '）')
  fs.mkdirSync(runtimeDir, { recursive: true })
  const zip = path.join(cacheDir, 'node-' + want + '.zip')
  const url = settings.nodeBase + '/v' + settings.nodeVersion + '/node-v' + want + '.zip'
  const extracted = path.join(runtimeDir, 'node-v' + want)
  // 绝不能「先删现役 runtime 再下载」：下载或解压一失败，原本可用的环境就被自己毁掉了；
  // 连 .version 标记也一起消失后，用户就算把 nodeVersion 改回原值，也得重新联网才能恢复——
  // 而 README 承诺网络不可用时可继续用本地环境。所以先备好新版本，最后一步才替换。
  try {
    await downloadFile(url, zip, '下载 Node.js')
    fs.rmSync(extracted, { recursive: true, force: true })
    await extractZip(zip, runtimeDir, '解压 Node.js')
    if (!fs.existsSync(path.join(extracted, 'node.exe'))) throw new Error('Node.js 解压后未找到 node.exe')
    await swapDir(extracted, nodeDir, 'Node.js 运行时', 'node.exe')
  } catch (e) {
    fs.rmSync(extracted, { recursive: true, force: true }) // 清掉半成品解压目录，不留垃圾
    const keep = fs.existsSync(nodeExe) ? '（现有 runtime 未被删除，把 nodeVersion 改回原值即可离线继续使用）' : ''
    throw new Error(String((e && e.message) || e) + keep)
  }
  fs.writeFileSync(marker, want)
  log('Node.js 就绪: ' + (await execVersion(nodeExe, ['-v'])))
}

async function ensureGit() {
  if (fs.existsSync(gitExe)) return
  log('准备便携版 Git（MinGit）')
  fs.rmSync(gitDir, { recursive: true, force: true })
  fs.mkdirSync(runtimeDir, { recursive: true })
  const zip = path.join(cacheDir, 'mingit.zip')
  await downloadFile(settings.mingitUrl, zip, '下载 Git')
  await extractZip(zip, gitDir, '解压 Git')
  if (!fs.existsSync(gitExe)) throw new Error('MinGit 解压后未找到 git.exe')
  log('Git 就绪')
}

async function ensurePnpm() {
  const marker = path.join(pnpmDir, '.version')
  // 同上：只在现役 pnpm 完好时才清理 .old，避免删掉唯一可用的副本
  if (fs.existsSync(pnpmJs)) {
    try { fs.rmSync(pnpmDir + '.old', { recursive: true, force: true }) } catch (e) { /* 仍被占用，下次再试 */ }
  }
  if (fs.existsSync(pnpmJs) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === settings.pnpmVersion) return
  log('准备 pnpm@' + settings.pnpmVersion)
  fs.mkdirSync(runtimeDir, { recursive: true })
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  // 与 ensureNode 同理：先装到暂存目录，确认装好再替换现役 pnpm。
  // 装失败/断网时旧 pnpm 原样保留，改回 pnpmVersion 即可离线继续用
  const staging = path.join(runtimeDir, 'pnpm.staging')
  fs.rmSync(staging, { recursive: true, force: true })
  try {
    await runOk(nodeExe, [npmCli, 'install', '--global', '--prefix', staging, 'pnpm@' + settings.pnpmVersion,
      '--cache', path.join(cacheDir, 'npm-cache'), '--registry', settings.npmRegistry,
      '--no-audit', '--no-fund', '--no-update-notifier'], '安装 pnpm')
    if (!fs.existsSync(path.join(staging, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))) {
      throw new Error('pnpm 安装后未找到 pnpm.cjs')
    }
    await swapDir(staging, pnpmDir, 'pnpm', path.join('node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true })
    const keep = fs.existsSync(pnpmJs) ? '（现有 pnpm 未被删除，把 pnpmVersion 改回原值即可离线继续使用）' : ''
    throw new Error(String((e && e.message) || e) + keep)
  }
  fs.writeFileSync(marker, settings.pnpmVersion)
  log('pnpm 就绪: ' + settings.pnpmVersion)
}

// ==================== 源码与更新 ====================
// 返回值：{ updated: 是否更新了源码, offline: 是否因为网络不可达而没能核对远程版本 }
async function ensureSource(forceCheck) {
  fs.mkdirSync(sourceParent, { recursive: true })
  const check = forceCheck || settings.updateCheck !== 'off'
  let remoteSha = ''
  let offline = false
  if (check) {
    try { remoteSha = await gitLsRemote() } catch (e) { offline = true; log('无法连接 GitHub，跳过更新检查（离线运行）') }
  }
  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    log('从 GitHub 克隆源码（' + settings.branch + ' 分支）...')
    // 先克隆到临时目录，成功后再替换，失败时保留旧源码
    const tmpClone = sourceDir + '.cloning'
    fs.rmSync(tmpClone, { recursive: true, force: true })
    await runOk(gitExe, ['clone', '--depth', '1', '--branch', settings.branch, settings.repoUrl, tmpClone], '克隆源码', { env: envFor() })
    fs.rmSync(sourceDir, { recursive: true, force: true })
    fs.renameSync(tmpClone, sourceDir)
    log('源码克隆完成')
    return { updated: true, offline: offline }
  }
  const localSha = await gitRevParse()
  if (remoteSha && remoteSha !== localSha) {
    log('发现新版本，更新源码: ' + localSha.slice(0, 8) + ' -> ' + remoteSha.slice(0, 8))
    await runGit(['fetch', '--depth', '1', 'origin', settings.branch], '拉取更新')
    await runGit(['reset', '--hard', 'FETCH_HEAD'], '应用更新')
    // reset --hard 只同步受版本管理的文件，被 gitignore 的旧编译产物必须手动清理，
    // 否则上一版本的产物会污染新版本构建（曾导致 MISSING_EXPORT 构建失败）
    cleanBuildArtifacts()
    log('源码已更新')
    return { updated: true, offline: offline }
  }
  if (offline) {
    log('未能确认远程版本（离线），继续使用本地源码 ' + (localSha || '本地').slice(0, 8))
    return { updated: false, offline: true }
  }
  log('源码已就绪（' + (localSha || '本地').slice(0, 8) + '），无需更新')
  return { updated: false, offline: false }
}

async function gitRevParse() {
  // 给足 60 秒：本地 rev-parse 通常毫秒级，但杀软/慢盘可能拖很久，
  // 一旦超时返回空串会被当成「构建产物与源码不匹配」而触发一次多余的全量构建
  const out = await runCapture(gitExe, ['-C', sourceDir, 'rev-parse', 'HEAD'], { env: envFor(), timeout: 60000 })
  const sha = String(out || '').trim()
  // 校验形状：超时被 kill 时可能拿到半行输出，残缺的 sha 会被写进 .built-sha 导致此后每次启动都重建
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : ''
}

// 异步执行：以前用 spawnSync 同步等待，GitHub 不可达时会把主进程（窗口 / 托盘 / IPC）
// 整整卡住最长 60 秒——而这恰好是文档承诺「离线可用」的场景
async function gitLsRemote() {
  const out = String(await runCapture(gitExe, ['ls-remote', settings.repoUrl, 'refs/heads/' + settings.branch],
    { env: envFor(), timeout: GIT_LS_REMOTE_TIMEOUT_MS }) || '').trim()
  if (!out) { throw new Error('ls-remote 无输出') }
  const sha = out.split(/\s+/)[0]
  // 校验形状：超时被 kill 时可能拿到半行输出，残缺的 sha 会被误判成「有新版本」
  if (!/^[0-9a-f]{40}$/i.test(sha)) { throw new Error('ls-remote 输出异常: ' + shorten(out, 80)) }
  return sha
}

async function runGit(args, label) {
  log(label + ' ...')
  return runOk(gitExe, ['-C', sourceDir].concat(args), label, { env: envFor() })
}

// 清理旧编译产物：git reset --hard 不会删除被 gitignore 的 lib/dist/tsbuildinfo，
// 上一版本的这些残留会被新版本构建误用导致构建失败。删除源码树下全部 lib/dist
// 目录与 *.tsbuildinfo 文件（跳过 node_modules），效果等价于干净检出。
function cleanBuildArtifacts() {
  let removed = 0
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const ent of entries) {
      // 跳过依赖目录、.git 与符号链接/junction：
      // pnpm 在 Windows 上大量使用 junction，递归删除会误删链接目标
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.isSymbolicLink()) continue
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'lib' || ent.name === 'dist') {
          try { fs.rmSync(p, { recursive: true, force: true }); removed++ } catch (e) { /* 忽略 */ }
        } else {
          walk(p)
        }
      } else if (ent.name.endsWith('.tsbuildinfo')) {
        try { fs.rmSync(p, { force: true }); removed++ } catch (e) { /* 忽略 */ }
      }
    }
  }
  walk(sourceDir)
  if (removed > 0) log('已清理旧编译产物 ' + removed + ' 项（lib/dist/tsbuildinfo）')
}

// ==================== 依赖与构建 ====================
async function installDeps() {
  await runOk(nodeExe, [pnpmJs, 'install', '--frozen-lockfile', '--dir', sourceDir,
    '--store-dir', pnpmStoreDir, '--registry', settings.npmRegistry,
    '--config.confirmModulesPurge=false'], '安装依赖（pnpm，首次需下载较多内容）', { env: envFor() })
  log('依赖安装完成')
}

async function builtMatches() {
  try {
    const marker = path.join(sourceParent, '.built-sha')
    if (!fs.existsSync(marker)) return false
    return fs.readFileSync(marker, 'utf8').trim() === (await gitRevParse())
  } catch (e) { return false }
}

async function buildProject() {
  await runOk(nodeExe, [pnpmJs, '--dir', sourceDir, 'run', 'build:lib:host'],
    '[1/3] build:lib:host —— 编译宿主库（tsc 约 1-3 分钟无输出属正常）', { env: envFor() })
  await runOk(nodeExe, [pnpmJs, '--dir', sourceDir, 'run', 'build:lib:client'],
    '[2/3] build:lib:client —— 编译客户端库', { env: envFor() })
  await runOk(nodeExe, [pnpmJs, '--dir', sourceDir, '--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build'],
    '[3/3] build:web —— 打包 Web 前端（vite）', { env: envFor() })
  // 只有在能读到合法提交号时才更新标记：写入空值会让此后每次启动都判定「需要重建」
  const sha = await gitRevParse()
  if (sha) {
    try { fs.writeFileSync(path.join(sourceParent, '.built-sha'), sha) } catch (e) { /* 忽略 */ }
  } else {
    log('警告: 未能读取当前提交号，未更新 .built-sha（下次启动会重新构建）')
  }
  log('构建完成')
}

// ==================== 启动 / 停止 ====================
async function startServer() {
  const limit = Math.min(settings.port + 50, 65535)
  let port = settings.port
  let badHost = false
  let hinted = false
  while (port <= limit) {
    const st = await probePort(port)
    if (st === 'free') break
    if (st === 'badhost') { badHost = true; break }
    // 第一次遇到占用时顺带提示：占用者可能是上次未被纳入管理的 dsh
    log('端口 ' + port + ' 被占用，尝试 +1 ...' + (hinted ? '' : '（若是上次遗留的 dsh，可在任务管理器结束对应的 node 进程）'))
    hinted = true
    port++
  }
  if (badHost) {
    throw new Error('无法在本机监听 ' + settings.host + '（地址无效或本机不可用），请检查 settings.json 的 host')
  }
  if (port > limit) throw new Error('端口 ' + settings.port + ' 到 ' + limit + ' 全部被占用')
  if (port !== settings.port) log('本次临时使用端口 ' + port + '（下次启动仍从 ' + settings.port + ' 开始尝试）')
  log('启动 DeepSeek Harness: http://' + settings.host + ':' + port)

  const env = envFor()
  env.DSH_HOME = dataDir
  // 优先用构建产物入口（apps/cli/lib/bin.js，即 npm 包发布的正式入口）；
  // 仅当构建产物缺失时才退回 tsx 源码入口（apps/cli/src/bin.ts）兜底
  const useBuiltEntry = fs.existsSync(cliBuiltEntry)
  log(useBuiltEntry ? '启动方式: 构建产物 apps/cli/lib/bin.js' : '启动方式: 源码 tsx apps/cli/src/bin.ts（构建产物缺失，兜底）')
  const args = useBuiltEntry
    ? ['apps/cli/lib/bin.js', 'web']
    : ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web']
  args.push('--host', settings.host, '--port', String(port))
  if (!settings.openBrowser) args.push('--no-open')

  child = spawn(nodeExe, args, { cwd: sourceDir, windowsHide: true, env: env, stdio: ['ignore', 'pipe', 'pipe'] })
  const spawnedPid = child.pid // 固定下来：子进程 exit 后 child 会被置空，回调里不能再读 child.pid
  writeDshPid(spawnedPid, port, settings.host)
  let settled = false
  const settle = (err) => {
    if (settled) return
    settled = true
    if (err) { child = null; clearDshPid(); setStage('error', '启动失败：' + err.message); notify('启动失败', err.message) }
  }
  pipeLines(child.stdout, '', (line) => {
    // 只取第一个地址：有局域网地址时 dsh 打印的是
    // "dsh web: <本机地址> (LAN: <局域网地址>)"，用 \S+ 会把 LAN 段一起吞进来
    const m = line.match(/dsh web:\s+(https?:\/\/[^\s()]+)/)
    // 必须确认「还没定局、且不在退出流程中」：子进程的 'exit' 可能早于缓冲的 stdout 数据到达，
    // 迟到的地址行若照常处理，就会把刚写好的错误状态改回「运行中」、清掉错误横幅，
    // 还给一个已经退出的进程补写 PID 记录——面板于是谎报在运行
    if (m && !settled && !quitting && !exiting) {
      tokenUrl = m[1]
      uiUrl = hostPortOf(tokenUrl)
      // 把入口地址写进 PID 记录：否则启动器重启时只能去日志里找，
      // 而日志轮转两次以后启动行早就不在读取范围内，面板会丢掉「打开 Web UI」的地址
      writeDshPid(spawnedPid, port, settings.host, tokenUrl)
      lastError = '' // 启动成功即清掉上一次的错误横幅
      setStage('running')
      notify('DeepSeek Harness 已启动', tokenUrl)
      settle(null)
    }
  })
  pipeLines(child.stderr, '[stderr] ')
  const spawned = child
  child.on('exit', (code) => {
    // 迟到的退出事件：若期间已经启动了新的子进程，不要动新的 child / PID 记录
    if (child !== spawned) return
    child = null
    clearDshPid()
    if (quitting || exiting) return // 退出过程中不再更新任何 UI，避免操作已销毁对象
    if (!settled) {
      settled = true
      if (spawned.__stoppedByUser) {
        // 用户在 dsh 打印服务地址之前点了「停止」：这是正常的停止，绝不能报成启动失败
        tokenUrl = ''
        uiUrl = ''
        setStage('stopped')
      } else {
        setStage('error', '服务启动后立即退出（代码 ' + code + '）')
        notify('启动失败', '服务进程立即退出（代码 ' + code + '）')
      }
    } else if (state === 'running') {
      // 服务自己退出（崩溃 / 被任务管理器结束）：地址必须一起清掉，
      // 否则面板会继续显示一个已经没有服务的地址，且「打开 Web UI」仍可点
      tokenUrl = ''
      uiUrl = ''
      setStage('stopped')
      notify('DeepSeek Harness 已停止', '服务已停止')
    }
    // child 从非空变成 null 会影响 canStart/canStop/canUpdate。上面两个分支不一定都走到
    // ——例如面板点「停止」时 stopDshInner 已经 setStage('stopped')，而那一刻 child 还没被清空，
    // 面板就会一直停在「按钮全灰」。所以这里必须无条件再推一次快照。
    broadcast()
  })
  child.on('error', (err) => {
    // spawn 失败只会触发 error + close（不触发 exit），必须在这里清掉 child，
    // 否则 child 永远为真，之后所有「启动」都会被「已有任务正在进行」挡掉
    if (child === spawned) { child = null; clearDshPid() }
    if (!settled) { settled = true; setStage('error', '无法启动: ' + err.message) } else broadcast()
  })
  // 兜底等待：捕获到地址行后立即结束；否则最多等 START_TIMEOUT_MS（60 秒）。
  // dsh 首次启动要加载整个插件树，实测出现过 13 秒，原来的 15 秒上限会误杀正常启动
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (settled) { clearTimeout(timer); clearInterval(iv); resolve() }
    }, 300)
    const timer = setTimeout(() => { clearInterval(iv); resolve() }, START_TIMEOUT_MS)
  })
  if (!settled) {
    // 只有「端口确实被监听」才算服务已就绪；probePort 返回 badhost 时不能当成启动成功
    const listening = (await probePort(port)) === 'used'
    if (listening) {
      uiUrl = settings.host + ':' + port
      lastError = ''
      setStage('running')
      settle(null)
    } else {
      // 进程可能还活着但服务没起来：先杀掉再报错，避免变成孤儿进程（下次启动会端口冲突）
      const p = child
      settle(new Error('启动超时（' + Math.round(START_TIMEOUT_MS / 1000) + ' 秒内未打印服务地址）'))
      if (p) { try { p.kill() } catch (e) { /* 忽略 */ } }
    }
  }
}

// 标记「这个子进程是被用户主动结束的」（只对本进程启动的 child 有效）。
// startServer 的 exit 处理器据此区分「用户停止」与「服务自己崩了」——否则在启动过程中
// 点停止，会先正常置为已停止、又被迟到的 exit 事件覆盖成「服务启动后立即退出」的错误态
function markStoppedByUser(pid) {
  if (child && child.pid === pid) child.__stoppedByUser = true
}

async function stopDsh() {
  if (stopBusy) { log('停止流程正在进行，忽略重复请求'); return }
  stopBusy = true
  try {
    await stopDshInner()
  } finally {
    stopBusy = false
  }
}

// 面板的「停止」在 stopping 期间仍可点，托盘菜单也按记录判定可用，
// 因此需要上面的防重入包装，避免两套 kill/轮询并行、通知重复
async function stopDshInner() {
  const target = await resolveStoppablePid()
  const pid = target.pid
  if (!pid) {
    // none / dead / stale：没有可停止的目标（残留记录已被清掉），如实回到已停止
    tokenUrl = ''
    uiUrl = ''
    lastError = ''
    setStage('stopped')
    return
  }
  if (target.reason === 'unknown') {
    // 无法确认这个 PID 是否仍是 dsh（地址不可监听 / 旧记录没有地址 / PID 已被系统复用）。
    // 结束它可能误杀无关程序，只清记录又可能留下一个仍在服务的实例，
    // 所以在这里把选择交给用户，而不是替他决定。
    if (win && !win.isDestroyed() && !win.isVisible()) showWindow()
    const why = target.why || 'badhost'
    const head = why === 'recycled'
      ? '进程 ' + pid + ' 的启动时间晚于 PID 记录的时间：当初启动的 dsh 已经退出，这个 PID 被系统复用给了别的程序。'
      : why === 'noport'
        ? '这条 PID 记录来自旧版本，既没有端口也没有 host，日志里也推不出服务地址，没有任何可核对的线索。'
        : '记录中的地址（' + ((target.hosts || []).join(' / ') || '未知') + '）在本机已不可监听。'
    const choice = dialog.showMessageBoxSync(win || undefined, {
      type: 'question',
      title: '停止 DeepSeek Harness',
      message: '无法确认记录里的进程',
      detail: head + '\n\n因此无法确认进程 ' + pid + ' 是否仍是上次启动的 dsh。\n\n' +
        '· 结束进程并清理记录：如果它确实是 dsh 就正常停止；如果该 PID 已被系统复用给别的程序，会误杀那个程序。\n' +
        '· 只清理记录：不结束任何进程；若 dsh 仍在别处服务，它将不再受启动器管理（可在任务管理器中结束）。',
      buttons: ['结束进程并清理记录', '只清理记录（不结束进程）', '取消'],
      defaultId: 1,
      cancelId: 2,
      noLink: true
    })
    if (choice === 2) return
    if (choice === 0) { markStoppedByUser(pid); try { process.kill(pid) } catch (e) { /* 忽略 */ } }
    log(choice === 0 ? '按用户确认结束进程 ' + pid + ' 并清理记录' : '按用户选择只清理记录，未结束进程 ' + pid)
    clearDshPid()
    tokenUrl = ''
    uiUrl = ''
    lastError = ''
    setStage('stopped')
    collectEnv().catch(() => {})
    return
  }
  setStage('stopping', '正在停止 ...')
  const kill = () => { try { process.kill(pid) } catch (e) { /* 进程可能已退出，或权限不足（EPERM） */ } }
  // 标记「这个子进程是被用户主动停止的」：startServer 的 exit 处理器据此避免把一次正常停止
  // 报成「服务启动后立即退出」。首次启动最长要 13 秒，用户在这段时间里点「停止」是真实场景
  markStoppedByUser(pid)
  kill()
  let stopped = false
  for (let i = 0; i < 24; i++) {
    // 直接用目标 PID 判定存活：不要经 detectExternalPid（它会因 24 小时过期等原因
    // 清掉记录并返回 0，被误当成「已经停掉了」）
    if (!pidAlive(pid)) { stopped = true; break }
    await sleep(250)
    if (i === 8) kill() // 2 秒仍未退出，再补一次
  }
  if (!stopped) {
    // 停止失败：进程仍在运行（Windows 上只有管理员/属主才能终止更高权限的进程），
    // 此时既不能清 PID 记录（进程还活着），也不能谎报「已停止」
    lastError = '停止失败：进程 ' + pid + ' 未退出（可能权限不同或已被其它程序保护）'
    log(lastError)
    // notify 的 body 会被拼成「标题：正文」，这里不再重复带「停止失败：」前缀，避免日志出现双前缀
    notify('停止失败', '进程 ' + pid + ' 未退出（可能权限不同或已被其它程序保护）')
    setStage('running', '') // 清掉「正在停止 ...」的残留描述
    collectEnv().catch(() => {})
    return
  }
  clearDshPid()
  tokenUrl = ''
  uiUrl = ''
  lastError = '' // 停止成功：清掉可能残留的错误横幅
  setStage('stopped')
  notify('DeepSeek Harness 已停止', '服务已停止')
  collectEnv().catch(() => {})
}

// 判断 PID 记录里的 dsh 是否仍在提供服务：返回 { status: 'serving'|'stale'|'unknown', hosts }
//
// 两类地址要分开看：
//  - 「在服务」的见证：任一候选地址上有服务在听即可（记录里的 host / 日志里的 host / 当前 settings.host）
//  - 「不在服务」的见证：只认**最权威的地址**，即记录里的 host，其次当前 settings.host。
//    日志里的地址不能用来证明「没有服务」——dsh 无论绑在哪个地址，都会先打印本机回环地址
//    （127.0.0.1），拿它去探测必然空闲，会把绑在局域网地址上的活实例误判成残留。
//  - 权威地址不可监听（badhost，例如网卡/VPN 变化）时返回 unknown：既不能证明在服务，
//    也不能证明不在服务，交给调用方决定（当前是询问用户），绝不擅自结束进程或清记录。
async function probeRecordedService(rec, port) {
  const fromLog = (rec.port && rec.host) ? { host: '' } : hostPortFromLog()
  const authoritative = String(rec.host || settings.host || '').trim() // 唯一能证明「不在服务」的地址
  const others = []
  for (const h of [rec.host, fromLog.host, settings.host]) {
    const v = String(h || '').trim()
    if (v && v !== authoritative && !others.includes(v)) others.push(v)
  }

  if (authoritative) {
    const st = await probePort(port, authoritative)
    if (st === 'used') return { status: 'serving', hosts: [authoritative].concat(others) }
    if (st === 'free') return { status: 'stale', hosts: [authoritative].concat(others) }
  }
  // 权威地址探测不出结论（或压根没有）：再看别的候选地址上有没有服务在听
  for (const h of others) {
    if ((await probePort(port, h)) === 'used') return { status: 'serving', hosts: [authoritative].concat(others).filter(Boolean) }
  }
  return { status: 'unknown', hosts: [authoritative].concat(others).filter(Boolean) }
}

// 解析「可以安全结束的 dsh PID」：本进程自己启动的天然可信；
// 上次会话遗留的记录必须先确认其端口仍在提供服务——Windows 会复用 PID，
// 只凭 pid 存活就下杀手可能终止一个毫不相干的进程（未保存数据丢失）。
// 返回 { pid, reason, hosts?, why? }，reason 为 none/dead/stale/verified/own/unknown。
// unknown 表示「身份无法确认」，一律交给调用方询问用户，why 说明原因：
//   badhost  记录里的地址本机已不可监听
//   noport   旧记录没有端口，日志里也推不出地址，没有任何可核对的见证
//   recycled 端口上有服务，但占着这个 PID 的进程启动时间晚于记录时间（PID 被复用）
async function resolveStoppablePid() {
  if (child) return { pid: child.pid, reason: 'own' }
  const rec = readDshPidInfo()
  if (!rec) return { pid: 0, reason: 'none' }
  if (!pidAlive(rec.pid)) { clearDshPid(); return { pid: 0, reason: 'dead' } }
  const fromLog = (rec.port && rec.host) ? { host: '', port: 0 } : hostPortFromLog()
  const port = rec.port || fromLog.port
  // 旧记录且日志里也推不出端口：完全没有可核对的见证。旧版这里直接结束该 PID，
  // 但「PID 还活着」证明不了它就是 dsh（Windows 会复用 PID），所以改为询问用户
  if (!port) return { pid: rec.pid, reason: 'unknown', hosts: [], why: 'noport' }
  const probe = await probeRecordedService(rec, port)
  if (probe.status === 'serving') {
    // 端口上有人在服务还不够：也可能是被复用 PID 的陌生进程恰好占着这个端口，
    // 所以再用「进程启动时间 vs 记录时间」做一次反证（拿不到时间就不改变原判定）
    if (await pidRecycled(rec)) {
      return { pid: rec.pid, reason: 'unknown', hosts: probe.hosts, why: 'recycled' }
    }
    return { pid: rec.pid, reason: 'verified' }
  }
  if (probe.status === 'unknown') {
    // 权威地址不可监听：既不能证明在服务，也不能证明已结束。
    // 这里只如实返回「无法确认」，绝不擅自结束进程（那可能误杀被复用 PID 的程序），
    // 由调用方决定怎么处理（stopDshInner 会询问用户）。
    return { pid: rec.pid, reason: 'unknown', hosts: probe.hosts, why: 'badhost' }
  }
  log('PID 记录中的进程 ' + rec.pid + ' 未在端口 ' + port + ' 提供服务，按残留记录清理，不结束该进程')
  clearDshPid()
  return { pid: 0, reason: 'stale' }
}

// ==================== dsh 进程记录（纯 Node，PID 文件） ====================
function dshPidFile() {
  return path.join(runtimeDir, 'dsh.pid')
}

// 记录 pid、实际使用的端口与 host：端口/host 用于在停止前确认「这个 PID 仍然是我们启动的 dsh」，
// 因为 Windows 会复用 PID，单看 pid 存活无法区分 dsh 与后来占用同一 PID 的无关进程。
// host 也要记：用户改了 settings.json 的 host 后重启启动器时，按新 host 探测会「探测不到」
// 而把仍在运行的 dsh 记录误清掉。
// url（含 token）在拿到后补写：日志会被轮转，靠日志找回入口地址在长时间运行后必然失败
function writeDshPid(pid, port, host, url) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true })
    const prev = readDshPidInfo()
    const same = !!(prev && prev.pid === pid)
    // ts 必须保持首次写入的时间：它是「这个 PID 属于我们启动的进程」的时间基准，
    // 补写 url 时若刷新 ts，进程启动时间的反证（见 pidRecycled）就会失效
    const ts = (same && prev.ts) ? prev.ts : Date.now()
    const keepUrl = (url === undefined && same) ? prev.url : String(url || '')
    fs.writeFileSync(dshPidFile(), JSON.stringify({
      pid: pid, ts: ts, port: port || 0, host: String(host || ''), url: String(keepUrl || '')
    }))
  } catch (e) { /* 忽略 */ }
}

function clearDshPid() {
  try { fs.rmSync(dshPidFile(), { force: true }) } catch (e) { /* 忽略 */ }
}

// 进程是否存活：只有 ESRCH 才代表「进程不存在」。
// 权限不足时 process.kill(pid, 0) 抛 EPERM——那说明进程还活着，只是我们无权结束它，
// 把它当成「已退出」会导致误报已停止并删掉 PID 记录（正是要避免的情况）
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
}

// 查询指定 PID 的实际启动时间（毫秒时间戳）。纯 Node 拿不到这个信息，只能借系统命令：
// wmic 最快（Windows 10/11 大多还在），被移除的系统上退回 PowerShell；两者都拿不到就返回 0
// ＝「无法判断」。只在准备结束遗留记录里的进程时调用，不在热路径上
async function pidStartedAt(pid) {
  try {
    const out = await runCapture('wmic', ['process', 'where', 'processid=' + pid, 'get', 'CreationDate', '/value'], { timeout: 5000 })
    // 形如 CreationDate=20260919224211.123456+480（本地时间 + 时区偏移分钟数）
    const m = String(out || '').match(/CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d+)?/)
    if (m) {
      const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
      return local - (m[7] ? parseInt(m[7], 10) : 0) * 60000
    }
  } catch (e) { /* 退回 PowerShell */ }
  try {
    const out = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Id ' + pid + ' -ErrorAction Stop).StartTime.ToUniversalTime().Ticks'], { timeout: 8000 })
    const ticks = parseInt(String(out || '').trim(), 10)
    // .NET 的 DateTime.Ticks 从 0001-01-01 起算，Unix 纪元对应 621355968000000000 ticks。
    // 注意别用 11644473600000：那是 FILETIME（1601 起算）的偏移，会算出公元 3626 年，
    // 让「进程启动时间晚于记录时间」恒成立，进而把真实 dsh 误判成 PID 被复用
    if (ticks > 0) return Math.round(ticks / 10000) - 62135596800000
  } catch (e) { /* 无法判断 */ }
  return 0
}

// 现在占着这个 PID 的进程，是不是在我们写记录之后才启动的？是 ⇒ 它不是当初那个 dsh。
// 留 60 秒余量：正常启动的 dsh 不可能比记录时间晚这么多，而被复用的进程几乎必然晚得多。
// 拿不到启动时间时返回 false——无法判断就沿用原判定，不引入新的不确定性
async function pidRecycled(rec) {
  if (!rec.ts) return false
  const started = await pidStartedAt(rec.pid)
  if (!started) return false
  const recycled = started > rec.ts + 60000
  if (recycled) log('PID ' + rec.pid + ' 的进程启动时间晚于记录时间，判定为 PID 被系统复用，不结束它')
  return recycled
}

function readDshPidInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(dshPidFile(), 'utf8'))
    const pid = parseInt(info && info.pid, 10)
    if (!(pid > 0)) return null
    return {
      pid: pid,
      ts: parseInt(info.ts, 10) || 0,
      port: parseInt(info.port, 10) || 0,
      host: typeof info.host === 'string' ? info.host : '',
      url: typeof info.url === 'string' ? info.url : ''
    }
  } catch (e) { return null }
}

// 检测是否有 dsh 进程在运行（本启动器启动的，通过 PID 文件 + 进程存活探测）
function detectExternalPid() {
  try {
    const info = readDshPidInfo()
    if (!info) { if (fs.existsSync(dshPidFile())) clearDshPid(); return 0 }
    // 不按时间过期：记录里的 ts 只在启动时写一次，按时间丢弃会把「健康运行超过 24 小时」的
    // dsh 直接遗忘——进程还在服务、记录却没了，于是停止会谎报已停止、再启动会出现两个实例。
    // 防误判靠端口校验（resolveStoppablePid / detectExternal / startFlow），不是靠时间。
    // 只有确认进程真的不存在才清记录；EPERM（权限不足）说明它还活着
    if (!pidAlive(info.pid)) { clearDshPid(); return 0 }
    return info.pid
  } catch (e) { return 0 }
}

// 从日志里推断 dsh 上次使用的 host 与端口（旧版 PID 记录没有这两个字段时的兜底）
function hostPortFromLog() {
  const hp = hostPortOf(lastUiUrlFromLog())
  const i = hp.lastIndexOf(':')
  const n = i >= 0 ? parseInt(hp.slice(i + 1), 10) : 0
  return {
    host: i > 0 ? hp.slice(0, i) : '',
    port: Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0
  }
}

async function detectExternal() {
  const pid = detectExternalPid()
  if (!pid) return
  const before = state // 探测期间用户可能已触发别的流程，回来时不再抢状态
  const rec = readDshPidInfo()
  const fromLog = rec && !(rec.port && rec.host) ? hostPortFromLog() : { host: '', port: 0 }
  const port = (rec && rec.port) || fromLog.port || 0
  const probe = port && rec ? await probeRecordedService(rec, port) : { status: 'serving', hosts: [] }
  if (probe.status === 'stale') {
    // 端口在「记录里的地址」上明确空闲 => 这条记录已被系统复用给别的进程，不能据此宣称 dsh 在运行
    log('PID 记录中的进程 ' + pid + ' 未在端口 ' + port + ' 提供服务，按残留记录清理')
    clearDshPid()
    if (state === before) setStage('stopped')
    return
  }
  if (state !== before) return
  if (probe.status === 'unknown') {
    // 记录里的地址已经不可用：探测不出结论。仍然按「在运行」对待（不是错误态），
    // 用户可以从托盘/面板点「停止」清掉它，不会被永久卡住
    log('无法在 ' + probe.hosts.join(' / ') + ' 探测端口 ' + port + '（地址本机不可监听），按运行中对待记录里的进程 ' + pid)
  }
  const last = lastUiUrlFromLog()
  const saved = (rec && rec.url) ? rec.url : ''
  if (last) {
    uiUrl = hostPortOf(last)
    if (last.indexOf('token=') >= 0) tokenUrl = last
  } else if (saved) {
    // 日志里已经找不到启动行（长时间运行的 dsh 会把日志轮转掉）：改用 PID 记录里保存的地址
    log('日志中已找不到服务地址，改用 PID 记录里保存的入口地址')
    uiUrl = hostPortOf(saved)
    tokenUrl = saved
  } else if (port) {
    // 记录里也没有地址时，至少用端口补一个可点开的地址
    uiUrl = settings.host + ':' + port
  }
  // setStage 会重建托盘菜单并广播快照，而托盘「打开 Web UI」是否可用取决于 tokenUrl/uiUrl，
  // 所以必须**先**恢复地址再置状态：反过来的话菜单和最后一次广播拿到的都是空地址，
  // 托管（接管已运行的 dsh）后托盘那一项就永远是灰的
  setStage('running')
  notify('检测到 DeepSeek Harness', 'dsh 已在运行（外部启动），可在此停止或打开界面')
}

// 回读日志里的服务地址：先看当前日志，再退回轮转备份 launcher.log.1 / .2，
// 否则日志一轮转，「已运行」的 dsh 就再也拿不回地址（打开 Web UI 变灰）
function lastUiUrlFromLog() {
  const files = [uiLogPath]
  for (let i = 1; i <= LOG_BACKUPS; i++) files.push(uiLogPath + '.' + i)
  const texts = files
    .map((f) => readLogTail(f, LOG_TAIL_BYTES))
    .filter((t) => !!t)
  for (const text of texts) {
    // 优先找带 token 的完整地址（同样只取第一个地址，避开 LAN 段）
    const lines = text.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/dsh web:\s+(https?:\/\/[^\s()]+)/)
      if (m) return m[1]
    }
  }
  for (const text of texts) {
    const lines = text.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const p = lines[i].indexOf('启动 DeepSeek Harness: http://')
      if (p >= 0) {
        const h = lines[i].indexOf('http://')
        return lines[i].slice(h + 7).trim()
      }
    }
  }
  return ''
}

// ==================== 通用工具 ====================
// 异步执行命令并收集 stdout（替代 spawnSync：同步等待会阻塞整个主进程）
// 超时或启动失败一律返回已收集到的输出（空字符串），由调用方判断
function runCapture(cmd, args, options) {
  const opts = options || {}
  return new Promise((resolve) => {
    let out = ''
    let done = false
    let p = null
    const finish = (text) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(text)
    }
    const timer = setTimeout(() => {
      try { if (p) p.kill() } catch (e) { /* 忽略 */ }
      finish(out)
    }, opts.timeout || 15000)
    try {
      p = spawn(cmd, args, { windowsHide: true, env: opts.env })
    } catch (e) { finish(''); return }
    if (p.stdout) {
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (chunk) => { out += chunk })
    }
    // stderr 必须消费掉，否则管道写满会让子进程阻塞
    if (p.stderr) { p.stderr.setEncoding('utf8'); p.stderr.on('data', () => {}) }
    p.on('error', () => finish(''))
    // 用 'close' 而不是 'exit'：'close' 保证 stdout 管道已读完，不会截断输出
    p.on('close', () => finish(out))
  })
}

function envFor() {
  return Object.assign({}, process.env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_HTTP_LOW_SPEED_LIMIT: '1000',
    GIT_HTTP_LOW_SPEED_TIME: '30',
    PATH: nodeDir + ';' + path.join(gitDir, 'cmd') + ';' + (process.env.PATH || '')
  })
}

function runOk(cmd, args, label, options) {
  return new Promise((resolve, reject) => {
    log(label + ' ...')
    const p = spawn(cmd, args, Object.assign({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, options || {}))
    activeProc = p
    pipeLines(p.stdout, '')
    pipeLines(p.stderr, '[stderr] ')
    p.on('exit', (code) => {
      if (activeProc === p) activeProc = null
      if (code === 0) resolve()
      else reject(new Error(label + ' 退出码 ' + code))
    })
    p.on('error', (err) => {
      if (activeProc === p) activeProc = null
      reject(err)
    })
  })
}

function pipeLines(stream, prefix, onLine) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    const text = String(chunk).replace(/\r/g, '\n')
    buf += text
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.length > 0) {
        log(prefix + line)
        if (onLine) onLine(line)
      }
    }
  })
}

function downloadFile(url, dest, label) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const tmp = dest + '.part'

    const attempt = (u, redirects, isRetry) => {
      let connectTimer = null
      let idleTimer = null
      let settled = false
      let file = null

      // 清掉本轮的定时器、写流与半成品文件，保证重试从干净状态开始
      const cleanup = () => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        if (file) { try { file.destroy() } catch (e) { /* 忽略 */ } ; file = null }
        try { fs.rmSync(tmp, { force: true }) } catch (e) { /* 忽略 */ }
      }

      const fail = (err) => {
        if (settled) return
        settled = true
        cleanup()
        if (!isRetry) {
          log(label + ' 失败，重试一次: ' + (err && err.message ? err.message : err))
          attempt(u, 0, true)
        } else {
          reject(err)
        }
      }

      const onResponse = (res) => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirects >= 5) { fail(new Error('重定向过多')); return }
          // 重定向地址必须先校验再使用：new URL 与 https.get('http://…') 都会同步抛错，
          // 而这里是异步回调，抛出去就是主进程未捕获异常，且本 Promise 再也不会有结果
          let next = ''
          try {
            next = new URL(res.headers.location, u).toString()
          } catch (e) {
            fail(new Error(label + ' 重定向地址无效: ' + shorten(res.headers.location, 120)))
            return
          }
          if (!/^https:\/\//i.test(next)) {
            fail(new Error(label + ' 被重定向到非 HTTPS 地址，已拒绝: ' + shorten(next, 120)))
            return
          }
          settled = true // 本轮作废，交给下一次 attempt
          cleanup()
          attempt(next, redirects + 1, isRetry)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          fail(new Error(label + ' 下载失败 HTTP ' + res.statusCode))
          return
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        let lastLog = 0
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => { try { res.destroy(new Error('下载超时（60 秒无数据）')) } catch (e) { /* 忽略 */ } }, 60000)
        }
        resetIdle()
        res.on('data', (chunk) => {
          received += chunk.length
          resetIdle()
          const now = Date.now()
          if (now - lastLog > 1000 || (total > 0 && received >= total)) {
            lastLog = now
            const pct = total > 0 ? ' (' + Math.floor(received * 100 / total) + '%)' : ''
            log(label + ': ' + fmtMb(received) + (total > 0 ? ' / ' + fmtMb(total) : '') + pct)
          }
        })
        res.on('error', fail)
        file = fs.createWriteStream(tmp, { flags: 'w' })
        file.on('error', fail)
        // 必须等 'close'（文件句柄真正关闭）再改名，且改名失败要如实报错：
        // 原来在 'finish' 里同步改名并吞掉异常，落盘失败会伪装成“下载成功”，
        // 直到后面解压时才报出「未找到 node.exe / zip 结构无效」这种误导性错误
        file.on('close', () => {
          if (settled) return
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
          if (total > 0 && received !== total) {
            // 长度不符多半是传输被截断，交给 fail 走一次重试
            fail(new Error(label + ' 下载不完整（' + fmtMb(received) + ' / ' + fmtMb(total) + '）'))
            return
          }
          settled = true
          try {
            fs.rmSync(dest, { force: true })
            fs.renameSync(tmp, dest)
          } catch (e) {
            try { fs.rmSync(tmp, { force: true }) } catch (e2) { /* 忽略 */ }
            reject(new Error(label + ' 下载完成但落盘失败: ' + ((e && e.message) || e)))
            return
          }
          resolve()
        })
        res.pipe(file)
      }
      // https.get 对非法 URL / 非 HTTPS 协议会同步抛错：必须捕获后交给 fail，
      // 否则 Promise 永远不落地，startFlow 会一直卡在 busy=true
      const startRequest = (target) => {
        try {
          return https.get(target, { headers: { 'User-Agent': 'DeepSeekHarnessLauncher/1.0' } }, onResponse)
        } catch (e) {
          fail(e)
          return null
        }
      }
      const req = startRequest(u)
      if (!req) return
      req.on('error', fail)
      // 连接阶段超时
      connectTimer = setTimeout(() => { try { req.destroy(new Error('连接超时（30 秒）')) } catch (e) { /* 忽略 */ } }, 30000)
    }
    attempt(url, 0, false)
  })
}

// 纯 Node 实现的 ZIP 解压（支持 stored/deflate，无任何外部命令）
function extractZip(zip, destDir, label) {
  log(label + ' ...')
  fs.mkdirSync(destDir, { recursive: true })
  const buf = fs.readFileSync(zip)
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error(label + ' 失败：zip 结构无效')
  const total = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    entries.push({ name: name, method: method, compSize: compSize, localOff: localOff })
    off += 46 + nameLen + extraLen + commentLen
  }
  let count = 0
  for (const e of entries) {
    const safe = e.name.replace(/\\/g, '/')
    if (safe.split('/').some((s) => s === '..')) continue
    const target = path.join(destDir, ...safe.split('/'))
    if (safe.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const lf = e.localOff
    const lfNameLen = buf.readUInt16LE(lf + 26)
    const lfExtraLen = buf.readUInt16LE(lf + 28)
    const dataStart = lf + 30 + lfNameLen + lfExtraLen
    const comp = buf.slice(dataStart, dataStart + e.compSize)
    if (e.method === 0) {
      fs.writeFileSync(target, comp)
    } else if (e.method === 8) {
      fs.writeFileSync(target, zlib.inflateRawSync(comp))
    } else {
      throw new Error(label + ' 失败：不支持的压缩方式 ' + e.method + '（' + e.name + '）')
    }
    count++
  }
  log(label + ' 完成（' + count + ' 个文件）')
  return count
}

// dsh 绑定的是 settings.host（或记录里的 host），探测必须用同一个地址：
// 只探 127.0.0.1 时，占用具体网卡地址的进程会被漏判，导致把冲突端口交给 dsh
function probeHost(override) {
  const h = String(override || settings.host || '127.0.0.1').trim()
  return (h === '' || h === '*') ? '0.0.0.0' : h
}

// 端口状态：'free' 空闲 / 'used' 已被监听 / 'badhost' 该地址本机无法监听
// 必须区分后两者：把「地址不可用」当成「端口被占用」会让端口扫描一路失败，
// 也会让启动等待把「监听失败」误判成「服务已就绪」
//
// 探测本身要占用端口，因此必须串行：两个并发探测同一个空闲端口会互相把对方挤成
// 「被占用」（一个真正占住了，另一个拿到 EADDRINUSE），使状态判定随机化
let probeChain = Promise.resolve()
function probePort(port, host) {
  const run = () => new Promise((resolve) => {
    let s = null
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      s = net.createServer()
      s.once('error', (err) => {
        const code = (err && err.code) || ''
        // 只有「地址本机不可用」才算 badhost；EADDRINUSE 固然是占用，
        // EACCES/EPERM（系统保留端口段）同样意味着这个端口拿不到，应继续往后找而不是整体失败
        if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND' || code === 'EINVAL') return finish('badhost')
        return finish('used')
      })
      s.listen(port, probeHost(host), () => {
        // 绑定成功只说明「这个地址可用」，不等于没人监听：Windows 允许在别人已监听 0.0.0.0:P 时
        // 再绑 127.0.0.1:P。虽然此时连 127.0.0.1:P 会落到后绑的那个套接字上（实测如此），
        // 但把同一个端口号交给两个不同服务是明确的坑：用户把 settings.host 改成通配/网卡地址后
        // dsh 会直接 EADDRINUSE，而「端口上是否还有我们的服务」也再无法区分。
        // 所以只要实连得上，就认为这个端口已经被占用，换下一个端口。
        s.close(() => {
          probeListening(port, host).then((busy) => {
            if (busy) return finish('used')
            // 通配地址下的补漏：别人可能只绑在某块网卡地址上监听同一端口（此时 Windows 仍允许
            // 通配绑定成功），只连回环会漏掉它，端口就被交出去，而面板给出的局域网地址其实打到
            // 别人的服务上。逐个本机地址补一次绑定探测即可发现（被占用会立刻 EADDRINUSE）
            if (!isWildcardHost(host)) return finish('free')
            probeAnyLocalBind(port).then((occupied) => finish(occupied ? 'used' : 'free'))
          })
        })
      })
    } catch (e) { finish('badhost') }
  })
  // 串行执行；任何意外都以 badhost 收尾——绝不把异常抛给调用方
  // （调用方分布在托盘菜单、IPC 与启动流程里，抛出去就是未处理的 Promise 拒绝）
  const next = probeChain.then(run, run).catch(() => 'badhost')
  probeChain = next.then(() => {}, () => {})
  return next
}

// 直接连一次端口：有东西在听就返回 true。
// 只在「地址绑定成功」之后调用，因此目标必定是本机可用地址，空闲端口会立刻
// ECONNREFUSED，不会拖慢端口扫描（51 个端口逐个探测仍然很快）
function probeListening(port, host) {
  return new Promise((resolve) => {
    let h = probeHost(host)
    if (h === '0.0.0.0' || h === '::') h = '127.0.0.1' // 通配地址不能直接连，改连回环
    let done = false
    const sock = net.connect({ port: port, host: h })
    const finish = (v) => {
      if (done) return
      done = true
      try { sock.destroy() } catch (e) { /* 忽略 */ }
      resolve(v)
    }
    sock.setTimeout(1500, () => finish(false))
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

function isWildcardHost(host) {
  const h = probeHost(host)
  return h === '0.0.0.0' || h === '::'
}

// 本机可用于绑定探测的地址（只取 IPv4，上限 8 个，避免网卡特别多的机器拖慢端口扫描）
function localBindAddresses() {
  const list = []
  try {
    const nis = os.networkInterfaces() || {}
    for (const name of Object.keys(nis)) {
      for (const a of nis[name] || []) {
        if (!a || !a.address || a.internal) continue
        if (a.family !== 'IPv4') continue
        if (!list.includes(a.address)) list.push(a.address)
      }
    }
  } catch (e) { /* 拿不到网卡清单时退化为只探回环 */ }
  return list.slice(0, 8)
}

// 逐个本机地址做绑定探测：某个地址已被监听就立刻 EADDRINUSE，不会像连接链路本地地址那样挂住
function probeAnyLocalBind(port) {
  const addrs = localBindAddresses()
  return new Promise((resolve) => {
    let i = 0
    const next = () => {
      if (i >= addrs.length) return resolve(false)
      const addr = addrs[i++]
      const s = net.createServer()
      let done = false
      const one = (busy) => {
        if (done) return
        done = true
        try { s.close(() => {}) } catch (e) { /* 忽略 */ }
        if (busy) return resolve(true)
        next()
      }
      s.once('error', (err) => {
        const code = (err && err.code) || ''
        // 地址本机不可用（网卡已断开等）不算被占用
        if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND' || code === 'EINVAL') return one(false)
        one(true)
      })
      try { s.listen(port, addr, () => one(false)) } catch (e) { one(false) }
    }
    next()
  })
}

function hostPortOf(url) {
  let u = url
  const i = u.indexOf('://')
  if (i >= 0) u = u.slice(i + 3)
  let j = u.indexOf('/')
  if (j >= 0) u = u.slice(0, j)
  j = u.indexOf('?')
  if (j >= 0) u = u.slice(0, j)
  return u
}

function fmtMb(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ==================== 环境依赖信息 ====================
// 异步取版本号：以前每次 collectEnv 都会同步阻塞主进程最多 7 次 × 15 秒
async function execVersion(cmd, args, opts) {
  const out = String(await runCapture(cmd, args, Object.assign({ timeout: 15000 }, opts || {})) || '')
    .trim().split(/\r?\n/)[0]
  return out || ''
}

function envItem(id, name, ready, version, detail, p) {
  return { id: id, name: name, ready: ready, version: version || '-', detail: detail || '', path: p }
}

async function collectEnv() {
  if (envComputing) return envCache || []
  envComputing = true
  try {
    const items = []
    // Node.js / Git / pnpm 三项并行探测，避免串行等待
    const nodeReady = fs.existsSync(nodeExe)
    const nodeMarker = fs.existsSync(path.join(nodeDir, '.version')) ? fs.readFileSync(path.join(nodeDir, '.version'), 'utf8').trim() : ''
    const gitReady = fs.existsSync(gitExe)
    const pnpmReady = fs.existsSync(pnpmJs)
    const [nodeVer, gitVer, pnpmVer] = await Promise.all([
      nodeReady ? execVersion(nodeExe, ['-v']) : Promise.resolve(''),
      gitReady ? execVersion(gitExe, ['--version']) : Promise.resolve(''),
      pnpmReady ? execVersion(nodeExe, [pnpmJs, '--version']) : Promise.resolve('')
    ])
    items.push(envItem('node', 'Node.js（便携）', nodeReady, nodeVer, nodeMarker, nodeDir))
    items.push(envItem('git', 'Git（MinGit）', gitReady, gitVer, '', gitDir))
    items.push(envItem('pnpm', 'pnpm', pnpmReady, pnpmVer, settings.pnpmVersion, pnpmDir))
    // 源码
    const srcReady = fs.existsSync(path.join(sourceDir, '.git'))
    let srcVer = ''
    if (srcReady) {
      const [sha, branch] = await Promise.all([
        execVersion(gitExe, ['-C', sourceDir, 'rev-parse', '--short', 'HEAD']),
        execVersion(gitExe, ['-C', sourceDir, 'rev-parse', '--abbrev-ref', 'HEAD'])
      ])
      srcVer = sha + '（' + (branch || settings.branch) + '）'
    }
    items.push(envItem('source', 'DeepSeek Harness 源码', srcReady, srcVer, settings.repoUrl, sourceDir))
    // 依赖
    const depsReady = fs.existsSync(path.join(sourceDir, 'node_modules', '.modules.yaml'))
    items.push(envItem('deps', '项目依赖', depsReady, depsReady ? '已安装' : '', 'pnpm store', pnpmStoreDir))
    // 用户数据
    items.push(envItem('data', '用户数据（DSH_HOME）', fs.existsSync(dataDir), 'DSH_HOME', '', dataDir))
    // 设置
    const cfgReady = fs.existsSync(settingsPath)
    items.push(envItem('config', '启动器设置', cfgReady, cfgReady ? '已生成' : '默认值', '', settingsPath))
    // 下载缓存
    items.push(envItem('cache', '下载缓存', fs.existsSync(cacheDir), fs.existsSync(cacheDir) ? '已缓存' : '', '安装包缓存', cacheDir))

    envCache = items
    pushEnv()
  } finally {
    envComputing = false
  }
  return envCache || []
}

function pushEnv() {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('env', envCache || []) } catch (e) { /* 忽略 */ }
  }
}

// 路径是否位于程序根目录内（严格前缀判断，防止同名兄弟目录被误放行）
function insideRoot(p) {
  const abs = path.resolve(String(p || ''))
  return abs === rootDir || abs.startsWith(rootDir + path.sep)
}

function openPath(p) {
  try {
    const target = path.resolve(String(p || ''))
    if (!insideRoot(target)) return
    let cur = target
    while (!fs.existsSync(cur)) {
      const par = path.dirname(cur)
      if (par === cur) break
      cur = par
    }
    const st = fs.statSync(cur)
    if (st.isDirectory()) shell.openPath(cur)
    else shell.showItemInFolder(cur)
  } catch (e) { /* 忽略 */ }
}

// ==================== 打开 / 设置 / 退出 ====================
function openWeb() {
  const url = tokenUrl || (uiUrl ? 'http://' + uiUrl : 'http://' + settings.host + ':' + settings.port)
  try { shell.openExternal(url) } catch (e) { notify('错误', '无法打开浏览器') }
}

function openLogs() {
  try { fs.mkdirSync(logDir, { recursive: true }); shell.openPath(logDir) } catch (e) { /* 忽略 */ }
}

function openFolder() {
  try { shell.openPath(rootDir) } catch (e) { /* 忽略 */ }
}

function setOpenAtLogin(enable) {
  try { app.setLoginItemSettings({ openAtLogin: enable, path: process.execPath }) } catch (e) { /* 忽略 */ }
}

// 退出流程里含异步的 PID 身份确认（见 resolveStoppablePid），
// 统一在这里兜住异常并保证最终一定会退出，调用方（托盘 / IPC）保持同步语义
function exitApp() {
  if (exiting) return // 托盘与面板可能同时触发；退出期也不再处理新的退出请求
  exiting = true
  exitAppAsync().catch(() => {
    quitting = true
    app.quit()
  })
}

async function exitAppAsync() {
  // 配置任务进行中：询问是否中断（否则子进程会变成孤儿继续运行）
  if (busy) {
    const c = dialog.showMessageBoxSync(win || undefined, {
      type: 'question',
      title: '退出确认',
      message: '配置任务正在进行中',
      detail: '直接退出会中断当前任务（下载/安装/构建）。确定退出？',
      buttons: ['中断任务并退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    if (c !== 0) { exiting = false; return }
    if (activeProc) {
      try { process.kill(activeProc.pid) } catch (e) { /* 忽略 */ }
      activeProc = null
    }
    // 只结束并清理「我们自己启动的子进程」；child 为空时可能还有接管的外部 dsh 在跑，
    // 这时绝不能顺手删掉 PID 记录（那会让它彻底脱离管理）
    const ownPid = child ? child.pid : 0
    if (ownPid) {
      try { process.kill(ownPid) } catch (e) { /* 忽略 */ }
      child = null
      for (let i = 0; i < 8 && pidAlive(ownPid); i++) await sleep(250)
      if (pidAlive(ownPid)) log('退出时未能结束进程 ' + ownPid + '（可能权限不足），已保留 PID 记录供下次接管')
      else clearDshPid()
    }
  }
  // 与「停止」同一套判定：遗留记录要先确认端口仍在服务，避免误杀被复用了 PID 的无关进程
  const target = await resolveStoppablePid()
  const pid = target.pid
  const dshActive = !!pid || state === 'running' || state === 'starting' || state === 'stopping'
  if (dshActive) {
    const choice = dialog.showMessageBoxSync(win || undefined, {
      type: 'question',
      title: '退出确认',
      message: 'DeepSeek Harness 正在运行',
      detail: '请选择退出方式',
      buttons: ['停止 dsh 并退出', '保持 dsh 后台运行，仅退出启动器', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })
    if (choice === 2) { exiting = false; return }
    if (choice === 0 && pid && target.reason !== 'unknown') {
      try { process.kill(pid) } catch (e) { /* 忽略 */ }
      // 等它真的退出；仍在运行就保留 PID 记录，下次启动还能继续接管
      for (let i = 0; i < 8 && pidAlive(pid); i++) await sleep(250)
      if (pidAlive(pid)) log('退出时未能结束进程 ' + pid + '（可能权限不足），已保留 PID 记录供下次接管')
      else clearDshPid()
    } else if (choice === 0 && target.reason === 'unknown') {
      // 身份无法确认：宁可留着记录让下次启动继续处理，也不在退出时误杀无关进程
      log('未结束进程 ' + pid + '（' + (target.why === 'recycled' ? 'PID 已被系统复用' : '无法确认身份') + '），已保留 PID 记录供下次处理')
    }
  }
  quitting = true
  try { if (tray) { tray.destroy(); tray = null } } catch (e) { /* 忽略 */ }
  app.quit()
}

// 无窗口应用：禁止默认的“全部窗口关闭即退出”行为
app.on('window-all-closed', () => { /* 托盘应用，不退出 */ })

// 系统注销/关机等路径退出时放行窗口关闭，避免 close 拦截卡住退出
app.on('before-quit', () => { quitting = true })
