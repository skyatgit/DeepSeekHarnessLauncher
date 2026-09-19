// 静态一致性自检：npm run check
// 覆盖那些「改了一处忘了另一处」才会暴露的跨文件契约：
// UI 元素 id / IPC 通道 / snapshot 与 env 字段 / 打包文件清单 / 版本号 / 设置项文档 / 状态徽章 / 语法
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
const build = read(path.join('scripts', 'build.js'))

// ---------- 1. UI 元素 id ----------
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
const usedIds = [...renderer.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1])
for (const id of usedIds) if (!htmlIds.has(id)) fail(`renderer.js 取用了 index.html 中不存在的 id: ${id}`)
for (const id of htmlIds) if (!usedIds.includes(id)) fail(`index.html 定义了但 renderer.js 未使用的 id: ${id}`)
notes.push(`UI id: ${htmlIds.size} 个，双向一致`)

// ---------- 2. IPC 通道 ----------
const handlers = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]))
const invokes = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1])
for (const c of invokes) if (!handlers.has(c)) fail(`preload.js 调用了未注册的 IPC 通道: ${c}`)
for (const c of handlers) if (!invokes.includes(c)) fail(`主进程注册了但 preload.js 未暴露的通道: ${c}`)
const sends = new Set([...main.matchAll(/webContents\.send\('([^']+)'/g)].map((m) => m[1]))
const ons = new Set([...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]))
for (const c of sends) if (!ons.has(c)) fail(`主进程推送了但 preload.js 未监听的事件: ${c}`)
for (const c of ons) if (!sends.has(c)) fail(`preload.js 监听了但主进程未推送的事件: ${c}`)
notes.push(`IPC: ${handlers.size} 个通道 / ${sends.size} 个事件，双向一致`)

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
const srcMatch = build.match(/SOURCE_FILES = \[([^\]]+)\]/)
const srcList = srcMatch ? srcMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')) : []
const fileList = pkg.build.files
if (JSON.stringify([...fileList].sort()) !== JSON.stringify([...srcList].sort())) {
  fail(`package.json build.files 与 scripts/build.js SOURCE_FILES 不一致\n    files: ${fileList.join(', ')}\n    build: ${srcList.join(', ')}`)
}
for (const f of fileList) if (!fs.existsSync(path.join(root, f))) fail(`打包清单中的文件不存在: ${f}`)
notes.push(`打包: ${fileList.length} 个文件，两份清单一致且都存在`)

// ---------- 5. 版本号 ----------
const lockRoot = lock.version
const lockPkg = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined
if (pkg.version !== lockRoot || pkg.version !== lockPkg) {
  fail(`版本号不一致: package.json=${pkg.version}, package-lock 顶层=${lockRoot}, packages[""]=${lockPkg}`)
}
const readmeVer = (readme.match(/应用版本：`([^`]+)`/) || [])[1]
if (readmeVer && readmeVer !== pkg.version) fail(`README 应用版本(${readmeVer}) 与 package.json(${pkg.version}) 不一致`)
notes.push(`版本: ${pkg.version}（package.json 与 package-lock 一致，README 单独校验）`)

// ---------- 6. 设置项与 README 文档 ----------
const defaults = main.slice(main.indexOf('const DEFAULT_SETTINGS'), main.indexOf('let settings ='))
const settingKeys = [...defaults.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1])
const readmeSettings = readme.slice(readme.indexOf('## 设置'), readme.indexOf('## 环境信息'))
for (const k of settingKeys) if (!readmeSettings.includes('`' + k + '`')) fail(`README 设置表缺少配置项: ${k}`)
notes.push(`设置: ${settingKeys.length} 项，README 全部有说明`)

// ---------- 7. 状态徽章覆盖 ----------
const states = new Set([...main.matchAll(/setStage\('([a-z]+)'/g)].map((m) => m[1]))
const badgeSrc = renderer.slice(renderer.indexOf('const BADGE_TEXT'), renderer.indexOf('// ---------- 节点式步骤条'))
const badgeKeys = new Set([...badgeSrc.matchAll(/([a-z]+):\s*'/g)].map((m) => m[1]))
for (const s of states) if (!badgeKeys.has(s)) fail(`状态 ${s} 在 renderer.js 的 BADGE_TEXT 中没有文案`)
notes.push(`状态: 主进程置位 ${states.size} 种，渲染层徽章全部覆盖`)

// ---------- 8. 语法 ----------
const jsFiles = ['main.js', 'preload.js', 'renderer.js', 'scripts/build.js', 'scripts/clean.js', 'scripts/check.js']
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
