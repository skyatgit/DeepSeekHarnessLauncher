// DeepSeekHarnessLauncher —— 主进程（流程完全内置，不依赖任何外部脚本）
// 完整流程：下载便携 Node.js / Git → GitHub 拉取源码 → pnpm 装依赖 → 构建 → 启动 dsh
// 另含：自动更新、端口自动避让、停止、托盘、主面板、开机自启
const { app, Tray, Menu, nativeImage, dialog, shell, BrowserWindow, ipcMain, screen } = require('electron')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')
const net = require('net')
const zlib = require('zlib')

// ==================== 路径 ====================
const appDir = __dirname
// 部署态：<项目>\dist\resources\app → 程序根 = dist\
// 开发态（npm run start，从源码运行）：<项目> 根 → 程序根 = 项目根
const deployedRoot = path.resolve(appDir, '..', '..')
const isDeployed = fs.existsSync(path.join(deployedRoot, 'resources', 'app', 'main.js'))
const rootDir = isDeployed ? deployedRoot : appDir
// Chromium 用户数据固定放用户级目录：单例锁在 Windows 上按 userData 划作用域，
// 各版本（安装/便携/开发）只有共享 userData 才能全局互斥，无论从哪个位置运行都只允许一个实例
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
function loadSettings() {
  settings = Object.assign({}, DEFAULT_SETTINGS)
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    if (saved && typeof saved === 'object') settings = Object.assign({}, DEFAULT_SETTINGS, saved)
  } catch (e) { /* 首次运行 */ }
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
let envCache = null
let envComputing = false
let taskStep = -1 // 步骤条：当前执行到的任务步骤下标；-1 表示无进行中任务
const logBuffer = []

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

function log(line) {
  const text = String(line)
  if (!text) return
  lastActivity = text
  try {
    fs.mkdirSync(logDir, { recursive: true })
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    fs.appendFileSync(uiLogPath, stamp + '  ' + text + '\r\n', 'utf8')
  } catch (e) { /* 忽略 */ }
  logBuffer.push(text)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('log-line', text) } catch (e) { /* 忽略 */ }
  }
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
// 全局统一锁名：无论便携版还是安装版，同一时间只允许运行一个启动器
const gotLock = app.requestSingleInstanceLock('dsh-launcher')
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.setAppUserModelId('com.deepseekharness.launcher')
  app.whenReady().then(init)
}

function init() {
  ensureDefaultSettings()
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  createWindow()
  tray = makeTray()
  rebuildMenu()
  detectExternal()
  collectEnv().catch(() => {})
  if (settings.autoStartDsh && state === 'stopped' && !child && !detectExternalPid()) startFlow()
}

// ==================== 主窗口 ====================
function createWindow() {
  // 高度自适应屏幕可用区域，保证全部内容（状态/环境列表/日志）完整可见
  let wa = { width: 1920, height: 1040 }
  try { wa = screen.getPrimaryDisplay().workAreaSize } catch (e) { /* 忽略 */ }
  const winWidth = Math.max(660, Math.min(wa.width - 160, 720))
  const winHeight = Math.min(Math.max(wa.height - 60, 800), 1000)
  win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 520,
    minHeight: 720,
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
    autoStartDsh: !!settings.autoStartDsh,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
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
    case 'running': return (child ? '' : '（外部）') + '运行中 http://' + uiUrl
    case 'stopping': return '停止中'
    case 'updating': return '更新中'
    case 'error': return '出错'
    default: return '已停止'
  }
}

// 环境是否已完整预装（全部就绪 = 无需任何准备，直接启动）
function isEnvReady() {
  try {
    if (!fs.existsSync(nodeExe) || !fs.existsSync(gitExe) || !fs.existsSync(pnpmJs)) return false
    if (!fs.existsSync(path.join(sourceDir, 'package.json'))) return false
    if (!fs.existsSync(path.join(sourceDir, 'node_modules', '.modules.yaml'))) return false
    if (!fs.existsSync(cliBuiltEntry)) return false
    return builtMatches()
  } catch (e) { return false }
}

// ==================== 完整启动流程 ====================
async function startFlow() {
  if (busy || child) { log('已有任务正在进行，忽略本次启动请求'); return }
  if (detectExternalPid()) { setStage('running'); return }
  busy = true
  lastError = ''
  try {
    if (isEnvReady()) {
      log('环境已就绪（已预装），直接启动')
    } else {
      setStage('provision', '准备环境（首次运行需下载，约 10~30 分钟）...')
      await ensureNode()
      await ensureGit()
      setStage('provision', '检查 pnpm ...')
      await ensurePnpm()
      setStage('fetch', '拉取源码 ...')
    }
    const updated = await ensureSource()

    if (updated || !fs.existsSync(path.join(sourceDir, 'node_modules', '.modules.yaml'))) {
      setStage('install', '安装依赖（pnpm）...')
      await installDeps()
    } else {
      log('依赖已就绪，跳过安装')
    }

    if (updated || !builtMatches() || !fs.existsSync(cliBuiltEntry)) {
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
    collectEnv().catch(() => {})
  }
}

async function updateFlow() {
  if (busy || child) { log('已有任务正在进行，忽略本次更新请求'); return }
  busy = true
  lastError = ''
  try {
    setStage('updating', '检查更新 ...')
    await ensureNode()
    await ensureGit()
    await ensurePnpm()
    const updated = await ensureSource(true)
    if (!updated) {
      log('已是最新版本，无需更新')
      notify('已是最新版本', '无需更新')
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
    collectEnv().catch(() => {})
  }
}

// ==================== 环境准备 ====================
async function ensureNode() {
  const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  const want = settings.nodeVersion + '-' + arch
  const marker = path.join(nodeDir, '.version')
  if (fs.existsSync(nodeExe) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === want) return
  log('准备便携版 Node.js v' + settings.nodeVersion + '（' + arch + '）')
  fs.rmSync(nodeDir, { recursive: true, force: true })
  fs.mkdirSync(runtimeDir, { recursive: true })
  const zip = path.join(cacheDir, 'node-' + want + '.zip')
  const url = settings.nodeBase + '/v' + settings.nodeVersion + '/node-v' + want + '.zip'
  await downloadFile(url, zip, '下载 Node.js')
  await extractZip(zip, runtimeDir, '解压 Node.js')
  const extracted = path.join(runtimeDir, 'node-v' + want)
  if (!fs.existsSync(path.join(extracted, 'node.exe'))) throw new Error('Node.js 解压后未找到 node.exe')
  fs.renameSync(extracted, nodeDir)
  fs.writeFileSync(marker, want)
  const r = spawnSync(nodeExe, ['-v'], { windowsHide: true, encoding: 'utf8' })
  log('Node.js 就绪: ' + String(r.stdout || '').trim())
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
  if (fs.existsSync(pnpmJs) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === settings.pnpmVersion) return
  log('准备 pnpm@' + settings.pnpmVersion)
  fs.rmSync(pnpmDir, { recursive: true, force: true })
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  await runOk(nodeExe, [npmCli, 'install', '--global', '--prefix', pnpmDir, 'pnpm@' + settings.pnpmVersion,
    '--cache', path.join(cacheDir, 'npm-cache'), '--registry', settings.npmRegistry,
    '--no-audit', '--no-fund', '--no-update-notifier'], '安装 pnpm')
  if (!fs.existsSync(pnpmJs)) throw new Error('pnpm 安装后未找到 pnpm.cjs')
  fs.writeFileSync(marker, settings.pnpmVersion)
  log('pnpm 就绪: ' + settings.pnpmVersion)
}

// ==================== 源码与更新 ====================
async function ensureSource(forceCheck) {
  fs.mkdirSync(sourceParent, { recursive: true })
  const check = forceCheck || settings.updateCheck !== 'off'
  let remoteSha = ''
  if (check) {
    try { remoteSha = await gitLsRemote() } catch (e) { log('无法连接 GitHub，跳过更新检查（离线运行）') }
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
    return true
  }
  const localSha = gitRevParse()
  if (remoteSha && remoteSha !== localSha) {
    log('发现新版本，更新源码: ' + localSha.slice(0, 8) + ' -> ' + remoteSha.slice(0, 8))
    await runGit(['fetch', '--depth', '1', 'origin', settings.branch], '拉取更新')
    await runGit(['reset', '--hard', 'FETCH_HEAD'], '应用更新')
    // reset --hard 只同步受版本管理的文件，被 gitignore 的旧编译产物必须手动清理，
    // 否则上一版本的产物会污染新版本构建（曾导致 MISSING_EXPORT 构建失败）
    cleanBuildArtifacts()
    log('源码已更新')
    return true
  }
  log('源码已就绪（' + (localSha || '本地').slice(0, 8) + '），无需更新')
  return false
}

function gitRevParse() {
  try {
    const r = spawnSync(gitExe, ['-C', sourceDir, 'rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf8' })
    return String(r.stdout || '').trim()
  } catch (e) { return '' }
}

function gitLsRemote() {
  return new Promise((resolve, reject) => {
    const r = spawnSync(gitExe, ['ls-remote', settings.repoUrl, 'refs/heads/' + settings.branch],
      { windowsHide: true, encoding: 'utf8', env: envFor(), timeout: 60000 })
    const out = String(r.stdout || '').trim()
    if (!out) { reject(new Error('ls-remote 无输出')); return }
    resolve(out.split(/\s+/)[0])
  })
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
      if (ent.name === 'node_modules') continue
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

function builtMatches() {
  try {
    const marker = path.join(sourceParent, '.built-sha')
    if (!fs.existsSync(marker)) return false
    return fs.readFileSync(marker, 'utf8').trim() === gitRevParse()
  } catch (e) { return false }
}

async function buildProject() {
  await runOk(nodeExe, [pnpmJs, '--dir', sourceDir, 'run', 'build:lib:host'],
    '[1/3] build:lib:host —— 编译宿主库（tsc 约 1-3 分钟无输出属正常）', { env: envFor() })
  await runOk(nodeExe, [pnpmJs, '--dir', sourceDir, 'run', 'build:lib:client'],
    '[2/3] build:lib:client —— 编译客户端库', { env: envFor() })
  await runOk(nodeExe, [pnpmJs, '--dir', sourceDir, '--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build'],
    '[3/3] build:web —— 打包 Web 前端（vite）', { env: envFor() })
  try { fs.writeFileSync(path.join(sourceParent, '.built-sha'), gitRevParse()) } catch (e) { /* 忽略 */ }
  log('构建完成')
}

// ==================== 启动 / 停止 ====================
async function startServer() {
  const limit = Math.min(settings.port + 50, 65535)
  let port = settings.port
  while (port <= limit) {
    if (await portFree(port)) break
    log('端口 ' + port + ' 被占用，尝试 +1 ...')
    port++
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
  writeDshPid(child.pid)
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
    if (m) {
      tokenUrl = m[1]
      uiUrl = hostPortOf(tokenUrl)
      setStage('running')
      notify('DeepSeek Harness 已启动', tokenUrl)
      settle(null)
    }
  })
  pipeLines(child.stderr, '[stderr] ')
  child.on('exit', (code) => {
    child = null
    clearDshPid()
    if (quitting) return // 退出过程中不再更新任何 UI，避免操作已销毁对象
    if (!settled) {
      settled = true
      setStage('error', '服务启动后立即退出（代码 ' + code + '）')
      notify('启动失败', '服务进程立即退出（代码 ' + code + '）')
    } else if (state === 'running') {
      tokenUrl = ''
      setStage('stopped')
      notify('DeepSeek Harness 已停止', '服务已停止')
    }
  })
  child.on('error', (err) => {
    if (!settled) { settled = true; setStage('error', '无法启动: ' + err.message) }
  })
  // 兜底：最多等 15 秒；捕获到 token 行后立即结束等待
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 15000)
    const iv = setInterval(() => {
      if (settled) { clearTimeout(timer); clearInterval(iv); resolve() }
    }, 300)
  })
  if (!settled) {
    const listening = !(await portFree(port))
    if (listening) {
      uiUrl = settings.host + ':' + port
      setStage('running')
      settle(null)
    } else {
      // 进程可能还活着但服务没起来：先杀掉再报错，避免变成孤儿进程（下次启动会端口冲突）
      const p = child
      settle(new Error('启动超时（15 秒内未打印服务地址）'))
      if (p) { try { p.kill() } catch (e) { /* 忽略 */ } }
    }
  }
}

async function stopDsh() {
  const pid = detectExternalPid() || (child ? child.pid : 0)
  if (!pid) return
  setStage('stopping', '正在停止 ...')
  try { process.kill(pid) } catch (e) { /* 忽略 */ }
  for (let i = 0; i < 20; i++) {
    if (!child && !detectExternalPid()) break
    await sleep(250)
  }
  clearDshPid()
  tokenUrl = ''
  uiUrl = ''
  setStage('stopped')
  notify('DeepSeek Harness 已停止', '服务已停止')
  collectEnv().catch(() => {})
}

// ==================== dsh 进程记录（纯 Node，PID 文件） ====================
function dshPidFile() {
  return path.join(runtimeDir, 'dsh.pid')
}

function writeDshPid(pid) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(dshPidFile(), JSON.stringify({ pid: pid, ts: Date.now() }))
  } catch (e) { /* 忽略 */ }
}

function clearDshPid() {
  try { fs.rmSync(dshPidFile(), { force: true }) } catch (e) { /* 忽略 */ }
}

// 检测是否有 dsh 进程在运行（本启动器启动的，通过 PID 文件 + 进程存活探测）
function detectExternalPid() {
  try {
    const f = dshPidFile()
    if (!fs.existsSync(f)) return 0
    const info = JSON.parse(fs.readFileSync(f, 'utf8'))
    const pid = parseInt(info && info.pid, 10)
    if (!(pid > 0)) { clearDshPid(); return 0 }
    // 超过 24 小时视为残留记录
    if (info && info.ts && Date.now() - info.ts > 24 * 3600 * 1000) { clearDshPid(); return 0 }
    try { process.kill(pid, 0); return pid } catch (e) { clearDshPid(); return 0 }
  } catch (e) { return 0 }
}

function detectExternal() {
  const pid = detectExternalPid()
  if (!pid) return
  setStage('running')
  const last = lastUiUrlFromLog()
  if (last) {
    uiUrl = hostPortOf(last)
    if (last.indexOf('token=') >= 0) tokenUrl = last
  }
  notify('检测到 DeepSeek Harness', 'dsh 已在运行（外部启动），可在此停止或打开界面')
}

function lastUiUrlFromLog() {
  try {
    if (!fs.existsSync(uiLogPath)) return ''
    const lines = fs.readFileSync(uiLogPath, 'utf8').split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      // 优先找带 token 的完整地址，其次找启动行（同样只取第一个地址，避开 LAN 段）
      const m = lines[i].match(/dsh web:\s+(https?:\/\/[^\s()]+)/)
      if (m) return m[1]
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const p = lines[i].indexOf('启动 DeepSeek Harness: http://')
      if (p >= 0) {
        const h = lines[i].indexOf('http://')
        return lines[i].slice(h + 7).trim()
      }
    }
  } catch (e) { /* 忽略 */ }
  return ''
}

// ==================== 通用工具 ====================
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
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
    const attempt = (u, redirects, isRetry) => {
      let connectTimer = null
      let idleTimer = null
      const fail = (err) => {
        if (connectTimer) clearTimeout(connectTimer)
        if (idleTimer) clearTimeout(idleTimer)
        if (!isRetry) {
          log(label + ' 失败，重试一次: ' + (err && err.message ? err.message : err))
          attempt(u, 0, true)
        } else {
          reject(err)
        }
      }
      const req = https.get(u, { headers: { 'User-Agent': 'DeepSeekHarnessLauncher/1.0' } }, (res) => {
        if (connectTimer) clearTimeout(connectTimer)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirects > 5) { fail(new Error('重定向过多')); return }
          attempt(new URL(res.headers.location, u).toString(), redirects + 1, isRetry)
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
        const file = fs.createWriteStream(tmp)
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => { try { res.destroy(new Error('下载超时（60 秒无数据）')) } catch (e) {} }, 60000)
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
        res.pipe(file)
        file.on('finish', () => {
          if (idleTimer) clearTimeout(idleTimer)
          file.close()
          try { fs.renameSync(tmp, dest) } catch (e) { /* 忽略 */ }
          resolve()
        })
        file.on('error', fail)
        res.on('error', fail)
      })
      req.on('error', fail)
      // 连接阶段超时
      connectTimer = setTimeout(() => { try { req.destroy(new Error('连接超时（30 秒）')) } catch (e) {} }, 30000)
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

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
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
function execVersion(cmd, args, opts) {
  try {
    const r = spawnSync(cmd, args, Object.assign({ windowsHide: true, encoding: 'utf8', timeout: 15000 }, opts || {}))
    const out = String(r.stdout || '').trim().split(/\r?\n/)[0]
    return out || ''
  } catch (e) { return '' }
}

function envItem(id, name, ready, version, detail, p) {
  return { id: id, name: name, ready: ready, version: version || '-', detail: detail || '', path: p }
}

async function collectEnv() {
  if (envComputing) return envCache || []
  envComputing = true
  try {
    const items = []
    // Node.js
    const nodeReady = fs.existsSync(nodeExe)
    const nodeMarker = fs.existsSync(path.join(nodeDir, '.version')) ? fs.readFileSync(path.join(nodeDir, '.version'), 'utf8').trim() : ''
    items.push(envItem('node', 'Node.js（便携）', nodeReady,
      nodeReady ? execVersion(nodeExe, ['-v']) : '', nodeMarker, nodeDir))
    // Git
    const gitReady = fs.existsSync(gitExe)
    items.push(envItem('git', 'Git（MinGit）', gitReady,
      gitReady ? execVersion(gitExe, ['--version']) : '', '', gitDir))
    // pnpm
    const pnpmReady = fs.existsSync(pnpmJs)
    items.push(envItem('pnpm', 'pnpm', pnpmReady,
      pnpmReady ? execVersion(nodeExe, [pnpmJs, '--version']) : '', settings.pnpmVersion, pnpmDir))
    // 源码
    const srcReady = fs.existsSync(path.join(sourceDir, '.git'))
    let srcVer = ''
    if (srcReady) {
      const sha = execVersion(gitExe, ['-C', sourceDir, 'rev-parse', '--short', 'HEAD'])
      const branch = execVersion(gitExe, ['-C', sourceDir, 'rev-parse', '--abbrev-ref', 'HEAD'])
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

function exitApp() {
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
    if (c !== 0) return
    if (activeProc) {
      try { process.kill(activeProc.pid) } catch (e) { /* 忽略 */ }
      activeProc = null
    }
    if (child) {
      try { process.kill(child.pid) } catch (e) { /* 忽略 */ }
      child = null
    }
    clearDshPid()
  }
  const dshActive = !!detectExternalPid() || child != null || state === 'running' || state === 'starting' || state === 'stopping'
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
    if (choice === 2) return
    if (choice === 0) {
      const pid = detectExternalPid() || (child ? child.pid : 0)
      if (pid) {
        try { process.kill(pid) } catch (e) { /* 忽略 */ }
        clearDshPid()
      }
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
