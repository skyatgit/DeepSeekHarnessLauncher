// 标准构建脚本：npm run build
// 流程：确保 Electron 运行时 → 备份运行数据 → 组装 dist → 复制源码 → 还原数据 → 设置 exe 图标
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
const electronInstall = path.join(root, 'node_modules', 'electron', 'install.js')
const outDir = path.join(root, 'dist')
const appOut = path.join(outDir, 'resources', 'app')

const SOURCE_FILES = ['main.js', 'preload.js', 'index.html', 'renderer.js', 'package.json', 'app.ico']
const KEEP_DIRS = ['runtime', 'cache', 'data', 'config', 'logs']

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function moveIfExists(src, dest) {
  if (fs.existsSync(src)) fs.renameSync(src, dest)
}

async function main() {
  // 1. 确保 Electron 运行时（npm 环境禁用 postinstall 时兜底）
  if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
    console.log('[1/4] Electron 运行时缺失，执行 install.js 补齐 ...')
    const r = spawnSync(process.execPath, [electronInstall], { stdio: 'inherit' })
    if (r.status !== 0) {
      console.error('错误: Electron 运行时安装失败，请先执行 npm install')
      process.exit(1)
    }
  } else {
    console.log('[1/4] Electron 运行时已就绪')
  }

  // 2. 备份运行数据（重建不清空环境）
  console.log('[2/4] 备份现有运行数据 ...')
  const backup = path.join(os.tmpdir(), 'dsh-dist-backup-' + Date.now())
  fs.mkdirSync(backup, { recursive: true })
  for (const d of KEEP_DIRS) moveIfExists(path.join(outDir, d), path.join(backup, d))

  // 3. 组装 dist
  console.log('[3/4] 组装 dist ...')
  rmrf(outDir)
  fs.mkdirSync(outDir, { recursive: true })
  copyDir(electronDist, outDir)
  fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, 'DeepSeekHarnessLauncher.exe'))

  // 4. 复制源码
  fs.mkdirSync(appOut, { recursive: true })
  for (const f of SOURCE_FILES) {
    const s = path.join(root, f)
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(appOut, f))
  }

  // 还原运行数据
  for (const d of KEEP_DIRS) moveIfExists(path.join(backup, d), path.join(outDir, d))
  rmrf(backup)

  // 5. 设置 exe 图标
  const appIco = path.join(root, 'app.ico')
  const exe = path.join(outDir, 'DeepSeekHarnessLauncher.exe')
  if (fs.existsSync(appIco)) {
    console.log('[4/4] 设置 exe 图标 ...')
    try {
      const rcedit = require('rcedit')
      await new Promise((resolve, reject) => {
        rcedit(exe, { icon: appIco }, (err) => (err ? reject(err) : resolve()))
      })
      console.log('图标已设置')
    } catch (e) {
      console.error('警告: 图标设置失败（不影响运行）:', e.message)
    }
  } else {
    console.log('[4/4] 未找到 app.ico，跳过图标设置')
  }

  console.log('')
  console.log('构建完成: ' + exe)
  console.log('整个 dist 文件夹即为可分发版本（自带运行时与图标）。')
}

main().catch((e) => {
  console.error('构建失败:', e)
  process.exit(1)
})
