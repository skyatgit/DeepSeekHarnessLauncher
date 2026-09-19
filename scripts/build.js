// 标准构建脚本：npm run build
// 流程：确保 Electron 运行时 → 备份运行数据 → 组装 dist → 复制源码 → 还原数据 → 写入图标与版本信息
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
const electronInstall = path.join(root, 'node_modules', 'electron', 'install.js')
const outDir = path.join(root, 'dist')
const appOut = path.join(outDir, 'resources', 'app')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const SOURCE_FILES = ['main.js', 'preload.js', 'index.html', 'renderer.js', 'package.json', 'app.ico']
// 便携部署时程序根就是 dist\（main.js 会据此判定），所以这些运行数据必须跨重建保留。
// source 同样是程序数据（克隆的源码 + node_modules + .built-sha），漏掉它等于每次重建都白等 10~30 分钟
const KEEP_DIRS = ['runtime', 'cache', 'data', 'config', 'logs', 'source']

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
  if (!fs.existsSync(src)) return
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    // rename 是 MoveFileEx，跨卷（例如 %TEMP% 被重定向到别的盘）会抛 EXDEV：
    // 这时退化为「递归复制 + 删除源」，与 NSIS 安装脚本里的 xcopy 回退同理
    if (e.code !== 'EXDEV') throw e
    fs.cpSync(src, dest, { recursive: true, force: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
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
  const moved = []
  try {
    for (const d of KEEP_DIRS) {
      const from = path.join(outDir, d)
      if (fs.existsSync(from)) {
        moveIfExists(from, path.join(backup, d))
        moved.push(d)
      }
    }

    // 3. 组装 dist
    console.log('[3/4] 组装 dist ...')
    rmrf(outDir)
    fs.mkdirSync(outDir, { recursive: true })
    copyDir(electronDist, outDir)
    fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, 'DeepSeekHarnessLauncher.exe'))
    // Electron 自带的兜底应用（存在 resources\app 时不会被使用），删掉以免混淆
    rmrf(path.join(outDir, 'resources', 'default_app.asar'))

    // 4. 复制源码
    fs.mkdirSync(appOut, { recursive: true })
    for (const f of SOURCE_FILES) {
      const s = path.join(root, f)
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(appOut, f))
    }

    // 还原运行数据
    for (const d of moved) moveIfExists(path.join(backup, d), path.join(outDir, d))
    rmrf(backup)
  } catch (err) {
    // 任何一步失败都不能把用户的运行数据留在 %TEMP%：逐个放回 dist\，并如实报告哪些没放回
    const stranded = []
    try {
      fs.mkdirSync(outDir, { recursive: true })
      for (const d of moved) {
        try { moveIfExists(path.join(backup, d), path.join(outDir, d)) } catch (e) { stranded.push(d) }
      }
    } catch (e) {
      // 连 outDir 都建不出来：把所有搬走过的目录都记为待恢复
      for (const d of moved) if (!stranded.includes(d)) stranded.push(d)
    }
    if (moved.length === 0) {
      // 备份阶段就失败了（例如跨卷且复制也失败）：没有数据被搬走，dist 保持原样
      rmrf(backup)
      console.error('构建中断，尚未搬动任何运行数据，' + outDir + ' 保持原样')
    } else if (stranded.length === 0) {
      rmrf(backup)
      console.error('构建中断，运行数据已全部放回 ' + outDir)
    } else {
      console.error('构建中断，以下运行数据未能放回：' + stranded.join('、'))
      console.error('它们仍在 ' + backup + ' ，请手动移回 ' + outDir)
    }
    throw err
  }

  // 5. 写入 exe 图标与版本信息
  const appIco = path.join(root, 'app.ico')
  const exe = path.join(outDir, 'DeepSeekHarnessLauncher.exe')
  if (!fs.existsSync(appIco)) {
    console.log('[4/4] 未找到 app.ico，跳过图标设置')
  } else {
    console.log('[4/4] 写入 exe 图标与版本信息 ...')
    try {
      const rcedit = require('rcedit')
      // rcedit 4.x 的签名是 async (exe, options)，没有回调参数。
      // 之前用 new Promise + 回调包装 → Promise 永不 settle：await 卡住，
      // 「图标已设置 / 构建完成」再也不打印，失败时还会变成未处理拒绝
      await rcedit(exe, {
        icon: appIco,
        'version-string': {
          CompanyName: pkg.author || 'DeepSeek Harness',
          FileDescription: pkg.productName || pkg.name,
          ProductName: pkg.productName || pkg.name,
          InternalName: pkg.productName || pkg.name,
          OriginalFilename: 'DeepSeekHarnessLauncher.exe',
          LegalCopyright: 'Copyright © ' + (pkg.author || 'DeepSeek Harness')
        },
        'file-version': pkg.version + '.0',
        'product-version': pkg.version + '.0'
      })
      console.log('图标与版本信息已写入（' + pkg.version + '）')
    } catch (e) {
      console.error('警告: 图标/版本信息写入失败（不影响运行）:', e.message)
    }
  }

  console.log('')
  console.log('构建完成: ' + exe)
  console.log('整个 dist 文件夹即为可分发版本（自带运行时与图标）。')
}

main().catch((e) => {
  console.error('构建失败:', e)
  process.exit(1)
})
